import { z } from "zod";
import { getLLM } from "../llm/index.js";
import { logger } from "../lib/logger.js";
import {
  buildRerankUserPrompt,
  RERANK_SYSTEM,
  type RerankCandidate,
} from "../llm/prompts/rerank_v2.js";
import type { SearchStateRow } from "../conversation/store.js";
import type { RetrievedCandidate } from "./retriever.js";

const RerankOutputSchema = z.object({
  ranked: z.array(
    z.object({
      founder_id: z.string().uuid(),
      score: z.number(),
      rationale: z.string().min(1).max(280),
      breakdown: z
        .object({
          role_fit: z.number(),
          reciprocal_fit: z.number(),
          sector_fit: z.number(),
          stage_fit: z.number(),
          location_fit: z.number(),
          anti_pref: z.number(),
        })
        .partial()
        .optional(),
    }),
  ),
});

export interface RankedCandidate {
  founder_id: string;
  score: number;
  rationale: string;
}

const TOP_N_TO_RERANK = 15;
const RETURN_TOP = 3;

function normalize(text: string): string {
  return text.toLowerCase();
}

function reciprocalBoost(candidate: RetrievedCandidate, state: SearchStateRow, userTurn: string): number {
  const text = normalize(`${candidate.headline} ${candidate.summary}`);
  const founderSide = normalize(`${userTurn} ${state.mustHave.join(" ")}`);

  if (/want a strong gtm \/ non-tech partner|marketing|growth|sales|gtm|non-tech/.test(founderSide)) {
    if (/looking for a non-tech cofounder|gtm-strong cofounder|sales and customer development/.test(text)) return 3;
  }
  if (/want a strong technical partner|need tech|need technical|engineering skills|technical cofounder/.test(founderSide)) {
    if (/looking for a technical cofounder|founder-level engineer|deeply technical cofounder/.test(text)) return 3;
  }
  if (/product-minded operating partner|product-minded/.test(founderSide)) {
    if (/product|customer development|discovery/.test(text)) return 2;
  }
  return 0;
}

function heuristicScore(candidate: RetrievedCandidate, state: SearchStateRow, userTurn: string): number {
  const roleFit = state.role && candidate.role_tags.includes(state.role) ? 3 : 0;
  const sectorFit = state.sector.length === 0
    ? 2
    : candidate.sector_tags.some((tag) => state.sector.includes(tag)) ? 3 : 0;
  const stageFit = state.stage.length === 0
    ? 2
    : candidate.stage_tags.some((tag) => state.stage.includes(tag)) ? 2 : 0;
  const locationFit = state.location.length === 0
    ? 2
    : state.location.some((location) => location.toLowerCase() === candidate.city.toLowerCase()) ? 3 : 0;
  const reciprocalFit = reciprocalBoost(candidate, state, userTurn);
  const antiPrefPenalty = state.antiPrefs.some((antiPref) => normalize(`${candidate.headline} ${candidate.summary}`).includes(normalize(antiPref))) ? 2 : 0;
  const exactSectorPenalty = state.sector.length > 0 && sectorFit === 0 ? 2 : 0;

  return roleFit + reciprocalFit + sectorFit + stageFit + locationFit - antiPrefPenalty - exactSectorPenalty;
}

function humanRationale(candidate: RetrievedCandidate, state: SearchStateRow, userTurn: string): string {
  const bits: string[] = [];
  if (state.sector.length && candidate.sector_tags.some((tag) => state.sector.includes(tag))) {
    bits.push(`${candidate.sector_tags[0]} overlap`);
  }
  if (reciprocalBoost(candidate, state, userTurn) > 0) {
    bits.push("wants the kind of counterpart you described");
  }
  if (state.location.length && state.location.some((location) => location.toLowerCase() === candidate.city.toLowerCase())) {
    bits.push(`based in ${candidate.city}`);
  }
  if (bits.length === 0 && state.role && candidate.role_tags.includes(state.role)) {
    bits.push(`${state.role} role fit`);
  }
  return bits.join(", ").slice(0, 140) || "closest fit on role, trajectory, and overall cofounder complement";
}

function cheapFallbackRank(
  candidates: RetrievedCandidate[],
  state: SearchStateRow,
  userTurn: string,
): RankedCandidate[] {
  // Deterministic fallback when LLM rerank fails or is skipped.
  return [...candidates]
    .sort((a, b) => heuristicScore(b, state, userTurn) - heuristicScore(a, state, userTurn))
    .slice(0, RETURN_TOP)
    .map((candidate) => ({
      founder_id: candidate.founder_id,
      score: heuristicScore(candidate, state, userTurn),
      rationale: humanRationale(candidate, state, userTurn),
    }));
}

export async function rerank(
  retrieved: RetrievedCandidate[],
  state: SearchStateRow,
  userTurn: string,
): Promise<RankedCandidate[]> {
  if (retrieved.length === 0) return [];

  const head = retrieved.slice(0, TOP_N_TO_RERANK);
  const forPrompt: RerankCandidate[] = head.map((c) => ({
    founder_id: c.founder_id,
    name: c.name,
    city: c.city,
    headline: c.headline,
    summary: c.summary,
    role_tags: c.role_tags,
    sector_tags: c.sector_tags,
    stage_tags: c.stage_tags,
    seniority: c.seniority,
  }));

  try {
    const parsed = await getLLM().json<z.infer<typeof RerankOutputSchema>>({
      system: RERANK_SYSTEM,
      user: buildRerankUserPrompt({
        searchState: {
          role: state.role,
          sector: state.sector,
          stage: state.stage,
          location: state.location,
          seniority: state.seniority,
          mustHave: state.mustHave,
          niceToHave: state.niceToHave,
          antiPrefs: state.antiPrefs,
        },
        userTurn,
        candidates: forPrompt,
      }),
      schemaName: "RerankOutput",
      temperature: 0.2,
      parse: (raw) => RerankOutputSchema.parse(JSON.parse(raw)),
    });
    // Filter to ids the LLM actually knew about (guard against hallucinated ids).
    const known = new Set(head.map((c) => c.founder_id));
    const filtered = parsed.ranked.filter((r) => known.has(r.founder_id));
    return filtered.slice(0, RETURN_TOP).map((r) => ({
      founder_id: r.founder_id,
      score: r.score,
      rationale: r.rationale.slice(0, 140),
    }));
  } catch (err) {
    logger.warn({ err }, "rerank fell back to retrieval order");
    return cheapFallbackRank(head, state, userTurn);
  }
}
