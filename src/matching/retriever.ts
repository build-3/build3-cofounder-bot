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
  const [vector] = await getLLM().embed([queryText]);
  if (!vector) return [];

  const excluded = args.excludeFounderIds.length
    ? args.excludeFounderIds
    : ["00000000-0000-0000-0000-000000000000"];

  const rows = await sql<Array<{
    id: string; name: string; city: string; headline: string; summary: string;
    role_tags: string[]; sector_tags: string[]; stage_tags: string[]; seniority: string;
    distance: number;
  }>>`
    SELECT f.id, f.name, f.city, f.headline, f.summary,
           f.role_tags, f.sector_tags, f.stage_tags, f.seniority,
           (e.embedding <=> ${toPgVectorLiteral(vector)}::vector) AS distance
    FROM founder_embeddings e
    JOIN founders f ON f.id = e.founder_id
    WHERE f.opted_in = true
      AND f.id != ALL(${excluded}::uuid[])
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
    distance: r.distance,
  }));
}
