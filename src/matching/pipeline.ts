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
        seniority: c.seniority,
        years_exp: c.years_exp,
        sector_tags: c.sector_tags,
        stage_tags: c.stage_tags,
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
  const header = total > 1
    ? `Closest fit right now (${index + 1}/${total})\n\n`
    : "Closest fit right now\n\n";

  // Meta line: seniority · years · top stage · top 2 sectors.
  // Kept short so the card stays scannable on a phone.
  const meta: string[] = [];
  if (card.seniority) meta.push(humanSeniority(card.seniority));
  if (card.years_exp > 0) meta.push(`${card.years_exp} yrs`);
  if (card.stage_tags[0]) meta.push(humanTag(card.stage_tags[0]));
  const topSectors = card.sector_tags.slice(0, 2).map(humanTag);
  if (topSectors.length) meta.push(topSectors.join(" / "));
  const metaLine = meta.length ? `${meta.join(" · ")}\n` : "";

  return (
    `${header}*${card.name}* — ${card.city}\n` +
    `${card.headline}\n` +
    `${metaLine}\n` +
    `_Why this could work:_ ${card.rationale}\n\n` +
    `Reply *Accept* to connect, *Skip* to see the next.`
  );
}

function humanSeniority(s: string): string {
  switch (s) {
    case "founder-level": return "Founder-level";
    case "senior-ic":     return "Senior IC";
    case "operator":      return "Operator";
    default:              return s;
  }
}

function humanTag(t: string): string {
  // "b2b-saas" → "B2B SaaS", "pre-seed" → "Pre-seed", "fintech" → "Fintech"
  const map: Record<string, string> = {
    "b2b-saas": "B2B SaaS",
    "ai-infra": "AI infra",
    "pre-idea": "Pre-idea",
    "pre-seed": "Pre-seed",
    "series-a": "Series A",
    "d2c": "D2C",
  };
  if (map[t]) return map[t]!;
  return t.charAt(0).toUpperCase() + t.slice(1);
}
