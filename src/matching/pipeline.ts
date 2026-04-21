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
  if (card.intro_recommendation === "hold") {
    return formatHoldCard(card);
  }

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

/**
 * Render a "hold" card. The reranker thinks this match is strong but the
 * intro is premature — we surface the reason and offer an override.
 *
 *   *Name* — City
 *
 *   • bullet one
 *   • bullet two
 *
 *   Holding off on this intro: <reason>
 *
 *   Reply *Force intro* to override, *Skip* to see others.
 */
export function formatHoldCard(card: CandidateCard): string {
  const header = `*${card.name}* — ${card.city}`;

  const bullets = card.bullets.filter((b) => b.trim().length > 0);
  const body =
    bullets.length > 0
      ? bullets.map((b) => `• ${b}`).join("\n")
      : card.rationale;

  const reason = card.hold_reason.trim();
  const reasonLine = reason
    ? `\n\nHolding off on this intro: ${reason}`
    : "\n\nHolding off on this intro for now.";

  return (
    `${header}\n\n` +
    `${body}` +
    `${reasonLine}\n\n` +
    `Reply *Force intro* to override, *Skip* to see others.`
  );
}

/**
 * Render two cards in one outbound message — preserves the
 * one-outbound-per-inbound contract. Only used when the reranker returned
 * at least two candidates and the second is within 60% of the top score.
 *
 * Shape:
 *
 *   Here are two worth looking at:
 *
 *   1) *Name* — City
 *   • bullet
 *   Potential drawback: …
 *
 *   2) *Name* — City
 *   • bullet
 *   Potential drawback: …
 *
 *   Reply *1* or *2* to pick one, *Skip* to see others.
 *
 * If either card is `hold`, its drawback slot becomes the hold reason and
 * the CTA drops to "*1*, *2*, or *Skip* — 1/2 means pick, Skip means next."
 * We intentionally don't split buttons per card here; WATI's 3-button cap
 * plus the one-outbound invariant make typed replies the only clean option.
 */
export function formatTwoCardsText(cards: [CandidateCard, CandidateCard]): string {
  const [a, b] = cards;
  return [
    "Here are two worth looking at:",
    "",
    renderOneInStack(1, a),
    "",
    renderOneInStack(2, b),
    "",
    "Reply *1* or *2* to pick one, *Skip* to see others.",
  ].join("\n");
}

function renderOneInStack(pos: number, card: CandidateCard): string {
  const header = `${pos}) *${card.name}* — ${card.city}`;
  const bullets = card.bullets.filter((x) => x.trim().length > 0);
  const body =
    bullets.length > 0 ? bullets.map((x) => `• ${x}`).join("\n") : card.rationale;

  let tail = "";
  if (card.intro_recommendation === "hold") {
    const reason = card.hold_reason.trim();
    tail = reason ? `\nHolding off: ${reason}` : "\nHolding off on this intro for now.";
  } else {
    const drawback = card.drawback.trim();
    tail = drawback ? `\nPotential drawback: ${drawback}` : "";
  }

  return `${header}\n${body}${tail}`;
}

/**
 * Should we show two cards instead of one?
 *
 * Yes iff the reranker returned at least two, both are warm (hold cards
 * always go solo so the Force-intro override isn't ambiguous), and the
 * runner-up is within 60% of the top score. This stops us from padding a
 * strong first card with a weak second one.
 */
export function shouldShowTwo(cards: CandidateCard[]): boolean {
  if (cards.length < 2) return false;
  const [a, b] = cards;
  if (!a || !b) return false;
  if (a.intro_recommendation === "hold" || b.intro_recommendation === "hold") return false;
  if (a.score <= 0) return false;
  return b.score >= 0.6 * a.score;
}
