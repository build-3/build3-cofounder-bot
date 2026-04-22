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
  /** Reranker score. Carried through to support the two-card confidence
   *  gate (runner-up must be within 60% of the top). */
  score: number;
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
  /** "warm" = ready to intro; "hold" = wait. See rerank_v4. */
  intro_recommendation: "warm" | "hold";
  /** Filled only when intro_recommendation === "hold". */
  hold_reason: string;
  seniority: string;
  years_exp: number;
  sector_tags: string[];
  stage_tags: string[];
  /** 0-3 from the reranker breakdown. 0 means this card misses the asked
   * sector entirely; the dispatcher prepends an honest gap preamble. */
  sector_fit?: number;
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
  recentTurns?: Array<{ direction: "in" | "out"; text: string }>;
}): Promise<RankedResult> {
  const { candidates: retrieved } = await retrieve({
    state: args.state,
    userTurn: args.userTurn,
    excludeFounderIds: [args.requesterId, ...args.alreadyShownFounderIds],
    ...(args.recentTurns ? { recentTurns: args.recentTurns } : {}),
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
        score: r.score,
        rationale: r.rationale,
        bullets: r.bullets,
        drawback: r.drawback,
        intro_recommendation: r.intro_recommendation,
        hold_reason: r.hold_reason,
        seniority: c.seniority,
        years_exp: c.years_exp,
        sector_tags: c.sector_tags,
        stage_tags: c.stage_tags,
        ...(typeof r.sector_fit === "number" ? { sector_fit: r.sector_fit } : {}),
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

/**
 * Return the most-recently-shown founder ids for this conversation in rank
 * order (position 1 first). Used by the two-card flow so "accept 1" /
 * "accept 2" resolve deterministically. `limit` caps the lookup window.
 */
export async function getLastShownFounderIds(
  conversationId: string,
  limit: number = 2,
  sql: Sql = getSql(),
): Promise<string[]> {
  const rows = await sql<Array<{ founder_id: string; rank: number }>>`
    SELECT founder_id, rank FROM candidates_shown
    WHERE conversation_id = ${conversationId}
    ORDER BY created_at DESC, rank ASC
    LIMIT ${limit}
  `;
  // DB returns most-recent first across the whole table; within a single
  // batch they'll share a created_at (±ms) so rank breaks the tie.
  return rows
    .slice()
    .sort((x, y) => x.rank - y.rank)
    .map((r) => r.founder_id);
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

