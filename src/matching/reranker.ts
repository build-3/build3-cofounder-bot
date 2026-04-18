import { z } from "zod";
import { getLLM } from "../llm/index.js";
import { logger } from "../lib/logger.js";
import {
  buildRerankUserPrompt,
  RERANK_SYSTEM,
  type RerankCandidate,
} from "../llm/prompts/rerank_v1.js";
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
          sector_fit: z.number(),
          stage_fit: z.number(),
          trajectory: z.number(),
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

function cheapFallbackRank(
  candidates: RetrievedCandidate[],
  state: SearchStateRow,
): RankedCandidate[] {
  // Deterministic fallback when LLM rerank fails or is skipped.
  return candidates.slice(0, RETURN_TOP).map((c) => {
    const sectorMatch = c.sector_tags.some((t) => state.sector.includes(t));
    const roleMatch = state.role ? c.role_tags.includes(state.role) : false;
    const locMatch = state.location.length === 0 ? true : state.location.some((l) => l.toLowerCase() === c.city.toLowerCase());
    const bits = [
      roleMatch ? `${state.role} background` : c.role_tags[0] ?? "cofounder profile",
      sectorMatch ? `works in ${c.sector_tags.join("/")}` : null,
      locMatch && state.location.length ? `based in ${c.city}` : null,
    ].filter(Boolean);
    return {
      founder_id: c.founder_id,
      score: -c.distance,
      rationale: bits.join("; ").slice(0, 140) || "retrieval match on profile similarity",
    };
  });
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
    return cheapFallbackRank(head, state);
  }
}
