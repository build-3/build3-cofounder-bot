import type { Sql } from "postgres";
import { getSql } from "../db/client.js";
import { getLLM } from "../llm/index.js";
import type { SearchStateRow } from "../conversation/store.js";
import { resolveSearchIntent, type SearchIntent } from "./intent.js";

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
  recentTurns?: Array<{ direction: "in" | "out"; text: string }>;
  k?: number; // default 50
}

function toPgVectorLiteral(vec: number[]): string {
  return `[${vec.join(",")}]`;
}

/**
 * Hybrid retrieval, driven entirely by the LLM-resolved SearchIntent:
 *  1. Ask the LLM to turn state + user turn into DB-ready tag filters.
 *  2. Embed the LLM's `semantic_query` (a description of the WANTED
 *     cofounder, not the asker).
 *  3. pgvector ANN cosine, k=50, with hard role-tag includes/excludes from
 *     the intent and soft sector/stage/city preferences surfaced through
 *     the embedding text.
 *  4. Hard-exclude requester + already-shown.
 *
 * The retriever no longer contains any hardcoded synonym maps or static
 * query templates — every decision about "which tags count as sales" or
 * "what does the query sentence look like" belongs to the LLM so it can
 * handle whatever the founder types.
 */
export async function retrieve(
  args: RetrieveArgs,
  sql: Sql = getSql(),
): Promise<{ candidates: RetrievedCandidate[]; intent: SearchIntent }> {
  const k = args.k ?? 50;

  const intent = await resolveSearchIntent({
    currentState: {
      role: args.state.role,
      sector: args.state.sector,
      stage: args.state.stage,
      location: args.state.location,
      seniority: args.state.seniority,
      mustHave: args.state.mustHave,
      niceToHave: args.state.niceToHave,
      antiPrefs: args.state.antiPrefs,
    },
    userTurn: args.userTurn,
    recentTurns: args.recentTurns ?? [],
  });

  const embedText = intent.semantic_query.trim().length > 0
    ? intent.semantic_query
    : args.userTurn;
  const [vector] = await getLLM().embed([embedText], { taskType: "RETRIEVAL_QUERY" });
  if (!vector) return { candidates: [], intent };

  const excluded = args.excludeFounderIds.length
    ? args.excludeFounderIds
    : ["00000000-0000-0000-0000-000000000000"];

  const hasRoleFilter = intent.role_tags.length > 0;
  const hasRoleExclusion = intent.role_tags_must_not.length > 0;

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
      AND (${!hasRoleFilter} OR f.role_tags && ${intent.role_tags}::text[])
      AND (${!hasRoleExclusion} OR NOT (f.role_tags && ${intent.role_tags_must_not}::text[]))
    ORDER BY e.embedding <=> ${toPgVectorLiteral(vector)}::vector
    LIMIT ${k}
  `;

  return {
    intent,
    candidates: rows.map((r) => ({
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
    })),
  };
}
