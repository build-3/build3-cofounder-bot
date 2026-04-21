import type { Sql } from "postgres";
import { getSql } from "../db/client.js";
import type { SearchStateRow } from "../conversation/store.js";
import { retrieve, type RetrievedCandidate } from "./retriever.js";
import { rerank, type RankedCandidate } from "./reranker.js";

export interface CandidateCard {
  founder_id: string;
  name: string;
  city: string;
  headline: string;
  /**
   * One short sentence — the best single reason this match is worth a
   * conversation. Persisted on `candidates_shown.rationale` and re-used as
   * the requester's note to the target when they accept (see consent flow).
   */
  rationale: string;
  /**
   * 2–3 operator-voice bullets used when rendering the card to the requester.
   * Not persisted — only the rationale is kept across turns.
   */
  bullets: string[];
  /** Honest "this could fail because…" line. Empty string means omit. */
  drawback: string;
  seniority: string;
  years_exp: number;
  sector_tags: string[];
  stage_tags: string[];
}

export interface RankedResult {
  cards: CandidateCard[];
  retrieved: RetrievedCandidate[];
}

export async function runMatching(args: {
  requesterId: string;
  state: SearchStateRow;
  userTurn: string;
  alreadyShownFounderIds: string[];
}): Promise<RankedResult> {
  const retrieved = await retrieve({
    state: args.state,
    userTurn: args.userTurn,
    excludeFounderIds: [args.requesterId, ...args.alreadyShownFounderIds],
  });
  const ranked = await rerank(retrieved, args.state, args.userTurn);

  const byId = new Map(retrieved.map((c) => [c.founder_id, c]));
  const cards: CandidateCard[] = ranked
    .map((r: RankedCandidate) => {
      const c = byId.get(r.founder_id);
      if (!c) return null;
      return {
        founder_id: c.founder_id,
        name: c.name,
        city: c.city,
        headline: c.headline,
        rationale: r.rationale,
        bullets: r.bullets,
        drawback: r.drawback,
        seniority: c.seniority,
        years_exp: c.years_exp,
        sector_tags: c.sector_tags,
        stage_tags: c.stage_tags,
      };
    })
    .filter((x): x is CandidateCard => x !== null);

  return { cards, retrieved };
}

/**
 * Record a card as shown. Returns true if inserted, false if we lost a race
 * (a concurrent dispatcher already recorded this founder for this conversation
 * — see 0002_concurrency_guards.sql). Caller MUST NOT send an outbound
 * message when this returns false, otherwise the user gets duplicate cards.
 */
export async function recordShown(
  conversationId: string,
  cards: CandidateCard[],
  sql: Sql = getSql(),
): Promise<boolean> {
  if (cards.length === 0) return false;
  let allInserted = true;
  await sql.begin(async (tx) => {
    for (let i = 0; i < cards.length; i++) {
      const c = cards[i]!;
      const rows = await tx<Array<{ id: string }>>`
        INSERT INTO candidates_shown (conversation_id, founder_id, rank, rationale, action)
        VALUES (${conversationId}, ${c.founder_id}, ${i + 1}, ${c.rationale}, 'shown')
        ON CONFLICT (conversation_id, founder_id) DO NOTHING
        RETURNING id
      `;
      if (rows.length === 0) allInserted = false;
    }
  });
  return allInserted;
}

export async function getShownFounderIds(
  conversationId: string,
  sql: Sql = getSql(),
): Promise<string[]> {
  const rows = await sql<Array<{ founder_id: string }>>`
    SELECT DISTINCT founder_id FROM candidates_shown WHERE conversation_id = ${conversationId}
  `;
  return rows.map((r) => r.founder_id);
}

export async function getLastShownFounderId(
  conversationId: string,
  sql: Sql = getSql(),
): Promise<string | null> {
  const rows = await sql<Array<{ founder_id: string }>>`
    SELECT founder_id FROM candidates_shown
    WHERE conversation_id = ${conversationId}
    ORDER BY created_at DESC LIMIT 1
  `;
  return rows[0]?.founder_id ?? null;
}

export async function markShownAction(
  conversationId: string,
  founderId: string,
  action: "accepted" | "skipped",
  sql: Sql = getSql(),
): Promise<void> {
  await sql`
    UPDATE candidates_shown
    SET action = ${action}
    WHERE conversation_id = ${conversationId}
      AND founder_id = ${founderId}
      AND action = 'shown'
  `;
}

/**
 * Render a single candidate card for WhatsApp.
 *
 * Shape (Boardy-style bullet-prose):
 *
 *   *Name* — City
 *
 *   • bullet one
 *   • bullet two
 *
 *   Potential drawback: …   (omitted if empty)
 *
 *   Reply *Accept* to connect, *Skip* to see the next.
 *
 * Bullets come from the reranker. If the reranker returned none (old v2
 * response shape, or an LLM that misbehaved), we fall back to the single-
 * line rationale so the card still reads.
 */
export function formatCardText(card: CandidateCard): string {
  const header = `*${card.name}* — ${card.city}`;

  const bullets = card.bullets.filter((b) => b.trim().length > 0);
  const body =
    bullets.length > 0
      ? bullets.map((b) => `• ${b}`).join("\n")
      : card.rationale;

  const drawback = card.drawback.trim();
  const drawbackLine = drawback ? `\n\nPotential drawback: ${drawback}` : "";

  return (
    `${header}\n\n` +
    `${body}` +
    `${drawbackLine}\n\n` +
    `Reply *Accept* to connect, *Skip* to see the next.`
  );
}
