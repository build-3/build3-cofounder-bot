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
  rationale: string;
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
      };
    })
    .filter((x): x is CandidateCard => x !== null);

  return { cards, retrieved };
}

export async function recordShown(
  conversationId: string,
  cards: CandidateCard[],
  sql: Sql = getSql(),
): Promise<void> {
  if (cards.length === 0) return;
  await sql.begin(async (tx) => {
    for (let i = 0; i < cards.length; i++) {
      const c = cards[i]!;
      await tx`
        INSERT INTO candidates_shown (conversation_id, founder_id, rank, rationale, action)
        VALUES (${conversationId}, ${c.founder_id}, ${i + 1}, ${c.rationale}, 'shown')
      `;
    }
  });
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

export function formatCardText(card: CandidateCard, index: number, total: number): string {
  const header = total > 1 ? `Match ${index + 1} of ${total}\n\n` : "";
  return (
    `${header}*${card.name}* — ${card.city}\n` +
    `${card.headline}\n\n` +
    `_Why:_ ${card.rationale}\n\n` +
    `Reply *Accept* to connect, *Skip* to see the next.`
  );
}
