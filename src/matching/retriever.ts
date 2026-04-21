import type { Sql } from "postgres";
import { getSql } from "../db/client.js";
import { getLLM } from "../llm/index.js";
import { assembleQuery } from "./weights.js";
import type { SearchStateRow } from "../conversation/store.js";

export interface RetrievedCandidate {
  founder_id: string;
  name: string;
  city: string;
  headline: string;
  summary: string;
  role_tags: string[];
  sector_tags: string[];
  stage_tags: string[];
  seniority: string;
  years_exp: number;
  distance: number; // cosine distance (lower = closer)
}

export interface RetrieveArgs {
  state: SearchStateRow;
  userTurn: string;
  excludeFounderIds: string[]; // requester + already-shown
  k?: number;                  // default 50
}

function toPgVectorLiteral(vec: number[]): string {
  return `[${vec.join(",")}]`;
}

/**
 * Role synonyms used as a hard tag filter. Returns null when no role is set
 * (meaning "no filter"). Keep synonyms aligned with the tag vocabulary we
 * write into founders.role_tags at ingest — see data/seed_founders.csv for
 * the canonical list.
 */
function synonymsForRole(role: string | null): string[] | null {
  if (!role) return null;
  const r = role.toLowerCase();
  if (["sales", "gtm", "bd", "marketing", "growth"].includes(r)) {
    return ["sales", "gtm", "bd", "marketing", "growth"];
  }
  if (["technical", "tech", "engineering", "engineer"].includes(r)) {
    return ["technical", "tech", "engineering", "engineer", "cto"];
  }
  if (["product", "pm"].includes(r)) {
    return ["product", "pm"];
  }
  if (["design", "designer"].includes(r)) {
    return ["design", "designer"];
  }
  if (["ops", "operations"].includes(r)) {
    return ["ops", "operations"];
  }
  // Unknown role string → don't filter, let semantic search handle it.
  return null;
}

/**
 * Hybrid retrieval. Steps:
 *  1. Assemble weighted query text from search state.
 *  2. Embed query.
 *  3. pgvector ANN (cosine), k=50 by default.
 *  4. Hard-exclude requester + already-shown.
 *  5. Hard-filter by must_have tokens if any match role/sector tags.
 *
 * Location is NOT used as a hard filter — LLM rerank handles it softly, so we
 * don't over-filter on a fuzzy preference like "Bangalore or NCR preferred".
 */
export async function retrieve(
  args: RetrieveArgs,
  sql: Sql = getSql(),
): Promise<RetrievedCandidate[]> {
  const k = args.k ?? 50;
  const queryText = assembleQuery(args.state, args.userTurn);
  const [vector] = await getLLM().embed([queryText], { taskType: "RETRIEVAL_QUERY" });
  if (!vector) return [];

  const excluded = args.excludeFounderIds.length
    ? args.excludeFounderIds
    : ["00000000-0000-0000-0000-000000000000"];

  // Hard role filter. role_tags on founders describe the founder's OWN role
  // (they ARE sales / ARE a PM / ARE technical). When the asker wants a role
  // X, we MUST return candidates whose role_tags include X — otherwise the
  // embedding can drag in profiles that merely mention role X in their
  // "looking for" text (e.g. an engineer who wants a GTM cofounder appearing
  // as a GTM match). See PROJECT_STATE for the 2026-04-22 incident.
  const roleFilter = synonymsForRole(args.state.role);

  const rows = await sql<Array<{
    id: string; name: string; city: string; headline: string; summary: string;
    role_tags: string[]; sector_tags: string[]; stage_tags: string[]; seniority: string;
    years_exp: number;
    distance: number;
  }>>`
    SELECT f.id, f.name, f.city, f.headline, f.summary,
           f.role_tags, f.sector_tags, f.stage_tags, f.seniority, f.years_exp,
           (e.embedding <=> ${toPgVectorLiteral(vector)}::vector) AS distance
    FROM founder_embeddings e
    JOIN founders f ON f.id = e.founder_id
    WHERE f.opted_in = true
      AND f.id != ALL(${excluded}::uuid[])
      AND (${roleFilter === null} OR f.role_tags && ${roleFilter ?? []}::text[])
    ORDER BY e.embedding <=> ${toPgVectorLiteral(vector)}::vector
    LIMIT ${k}
  `;

  return rows.map((r) => ({
    founder_id: r.id,
    name: r.name,
    city: r.city,
    headline: r.headline,
    summary: r.summary,
    role_tags: r.role_tags,
    sector_tags: r.sector_tags,
    stage_tags: r.stage_tags,
    seniority: r.seniority,
    years_exp: r.years_exp,
    distance: r.distance,
  }));
}
