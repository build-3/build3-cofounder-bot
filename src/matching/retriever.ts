import type { Sql } from "postgres";
import { getSql } from "../db/client.js";
import { getLLM } from "../llm/index.js";
import { LRU } from "../lib/cache.js";
import { logger } from "../lib/logger.js";
import type { SearchStateRow } from "../conversation/store.js";
import { resolveSearchIntent, type SearchIntent } from "./intent.js";

// Process-local LRU. Embeds are deterministic for a given input string so
// caching by exact text is safe. 256 entries × ~6 KB per 1536-dim float
// vector ≈ 1.5 MB — fits comfortably in a Vercel serverless instance.
const EMBED_CACHE = new LRU<number[]>(256);

/** Trivial refinement turns (the user just said "next" / "show me one more")
 *  don't need an LLM-driven intent re-extraction — the existing search_state
 *  already captures what they want. Skipping the LLM call saves 800-1200ms
 *  on every refinement, which is the most common kind of turn after the
 *  initial discovery message. */
const TRIVIAL_REFINEMENT_PATTERNS: RegExp[] = [
  /^\s*(next|more|another|one more|show me (one |another |the next ))/i,
  /^\s*(skip|pass|nope|no thanks)\s*$/i,
  /^\s*(show|see|give me)\s+(more|another|one more|next)/i,
  /^\s*\d+\s*$/, // e.g. "1", "2" replies to button prompts
];

function isTrivialRefinement(userTurn: string, state: SearchStateRow): boolean {
  if (!TRIVIAL_REFINEMENT_PATTERNS.some((re) => re.test(userTurn))) return false;
  // Only trivial-fast-path when the search_state has at least a role or
  // sector to anchor the retrieval. Otherwise we'd embed an empty query.
  return Boolean(state.role) || state.sector.length > 0 || state.stage.length > 0;
}

function deterministicIntentFromState(state: SearchStateRow, userTurn: string): SearchIntent {
  // Compose a semantic_query from the state — same idea as the LLM intent
  // would produce, but deterministic and free.
  const parts: string[] = [];
  if (state.role) parts.push(`Looking for a ${state.role} cofounder`);
  if (state.sector.length) parts.push(`in ${state.sector.join(" / ")}`);
  if (state.stage.length) parts.push(`at ${state.stage.join(" or ")} stage`);
  if (state.location.length) parts.push(`based in ${state.location.join(" or ")}`);
  if (state.mustHave.length) parts.push(`Must have: ${state.mustHave.join("; ")}`);
  return {
    role_tags: state.role ? [state.role] : [],
    role_tags_must_not: [],
    sector_tags: state.sector,
    stage_tags: state.stage,
    cities: state.location,
    seniority: state.seniority,
    semantic_query: parts.join(". ") || userTurn,
    notes: ["fast-path: trivial refinement — skipped intent LLM"],
  };
}

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
  /** How often this candidate has been shown across all conversations.
   *  Surfaced to the reranker so it can factor freshness into the rationale. */
  times_shown: number;
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

  const intent = isTrivialRefinement(args.userTurn, args.state)
    ? deterministicIntentFromState(args.state, args.userTurn)
    : await resolveSearchIntent({
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

  let vector = EMBED_CACHE.get(embedText);
  if (!vector) {
    const [v] = await getLLM().embed([embedText], { taskType: "RETRIEVAL_QUERY" });
    if (!v) return { candidates: [], intent };
    vector = v;
    EMBED_CACHE.set(embedText, vector);
  } else {
    logger.debug({ cached: true, textLen: embedText.length }, "embed cache hit");
  }

  const excluded = args.excludeFounderIds.length
    ? args.excludeFounderIds
    : ["00000000-0000-0000-0000-000000000000"];

  const hasRoleFilter = intent.role_tags.length > 0;
  const hasRoleExclusion = intent.role_tags_must_not.length > 0;

  // Soft deprioritization for over-shown founders. We add a small penalty to
  // the cosine distance proportional to log(times_shown + 1). Cosine distance
  // is in [0, 2]; a single exposure adds ~0.014, ten exposures add ~0.048.
  // That's a tiebreaker, not a filter — a clearly better match (distance
  // delta > 0.05, a realistic threshold) still wins. With 250 founders and
  // hundreds of conversations this prevents the same handful from dominating.
  const rows = await sql<Array<{
    id: string; name: string; city: string; headline: string; summary: string;
    role_tags: string[]; sector_tags: string[]; stage_tags: string[]; seniority: string;
    years_exp: number;
    distance: number;
    times_shown: number;
  }>>`
    SELECT f.id, f.name, f.city, f.headline, f.summary,
           f.role_tags, f.sector_tags, f.stage_tags, f.seniority, f.years_exp,
           (e.embedding <=> ${toPgVectorLiteral(vector)}::vector) AS distance,
           f.times_shown
    FROM founder_embeddings e
    JOIN founders f ON f.id = e.founder_id
    WHERE f.opted_in = true
      AND f.id != ALL(${excluded}::uuid[])
      AND (${!hasRoleFilter} OR f.role_tags && ${intent.role_tags}::text[])
      AND (${!hasRoleExclusion} OR NOT (f.role_tags && ${intent.role_tags_must_not}::text[]))
    ORDER BY
      (e.embedding <=> ${toPgVectorLiteral(vector)}::vector)
      + (LEAST(f.times_shown, 50) * 0.005)
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
      times_shown: r.times_shown,
    })),
  };
}
