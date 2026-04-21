import { z } from "zod";
import { getLLM } from "../llm/index.js";
import { logger } from "../lib/logger.js";
import {
  buildRerankUserPrompt,
  RERANK_SYSTEM,
  type RerankCandidate,
} from "../llm/prompts/rerank_v4.js";
import type { SearchStateRow } from "../conversation/store.js";
import type { RetrievedCandidate } from "./retriever.js";

const RerankOutputSchema = z.object({
  ranked: z.array(
    z.object({
      founder_id: z.string().uuid(),
      score: z.number(),
      rationale: z.string().min(1).max(280),
      // v3: bullets + drawback. Defaulted so a v2-shaped response (no
      // bullets) still parses — the card will just fall back to rationale.
      bullets: z.array(z.string().max(200)).max(4).default([]),
      drawback: z.string().max(240).default(""),
      // v4: hold/warm intro recommendation. Defaulted to "warm" so a v3-shaped
      // response (no recommendation) still parses and renders as a normal
      // warm card.
      intro_recommendation: z.enum(["warm", "hold"]).default("warm"),
      hold_reason: z.string().max(260).default(""),
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
  bullets: string[];
  drawback: string;
  /** "warm" = intro now; "hold" = good match but intro is premature. */
  intro_recommendation: "warm" | "hold";
  /** Required when intro_recommendation === "hold", else "". */
  hold_reason: string;
  /** 0-3 from the rerank breakdown. 0 = this card misses the asked sector
   * entirely and the caller should be honest about the gap. Undefined when
   * the LLM didn't return a breakdown (v2/v3 response shape). */
  sector_fit?: number;
}

const TOP_N_TO_RERANK = 8;
const RETURN_TOP = 3;
// Vercel caps serverless at 60s. LLM rerank is the single biggest time sink;
// if it can't finish in this budget we abandon it and use the deterministic
// fallback so the user still gets a card instead of a 504.
const RERANK_TIMEOUT_MS = 25_000;
// Output cap prevents the model from producing a partially-completed JSON blob
// that blows past response_format=json_object's implicit budget. 8 candidates
// × ~180 tokens of rationale/breakdown fits comfortably in 2k.
const RERANK_MAX_TOKENS = 2000;

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

function fallbackBullets(candidate: RetrievedCandidate): string[] {
  // Derived, not invented: headline is a single grounded fact; the first
  // sentence of summary is a second one. Good enough for the rare path where
  // the LLM is down.
  const bullets: string[] = [];
  if (candidate.headline) bullets.push(candidate.headline);
  const firstSentence = candidate.summary.split(/(?<=[.!?])\s+/)[0]?.trim();
  if (firstSentence && firstSentence !== candidate.headline) {
    bullets.push(firstSentence.slice(0, 180));
  }
  return bullets.slice(0, 3);
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
    .map((candidate) => {
      const sectorFit = state.sector.length === 0
        ? 2
        : candidate.sector_tags.some((tag) => state.sector.includes(tag)) ? 3 : 0;
      return {
        founder_id: candidate.founder_id,
        score: heuristicScore(candidate, state, userTurn),
        rationale: humanRationale(candidate, state, userTurn),
        bullets: fallbackBullets(candidate),
        drawback: "",
        intro_recommendation: "warm",
        hold_reason: "",
        sector_fit: sectorFit,
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
    const llmCall = getLLM().json<z.infer<typeof RerankOutputSchema>>({
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
      maxTokens: RERANK_MAX_TOKENS,
      parse: (raw) => RerankOutputSchema.parse(JSON.parse(raw)),
    });
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("rerank_timeout")), RERANK_TIMEOUT_MS),
    );
    const parsed = await Promise.race([llmCall, timeout]);
    // Filter to ids the LLM actually knew about (guard against hallucinated ids).
    const known = new Set(head.map((c) => c.founder_id));
    const filtered = parsed.ranked.filter((r) => known.has(r.founder_id));
    return filtered.slice(0, RETURN_TOP).map((r) => {
      const sectorFit = r.breakdown?.sector_fit;
      return {
        founder_id: r.founder_id,
        score: r.score,
        rationale: r.rationale.slice(0, 140),
        bullets: (r.bullets ?? [])
          .map((b) => b.trim())
          .filter((b) => b.length > 0)
          .slice(0, 3)
          .map((b) => b.slice(0, 180)),
        drawback: (r.drawback ?? "").trim().slice(0, 240),
        intro_recommendation: r.intro_recommendation ?? "warm",
        // Enforce the schema rule: hold_reason is only meaningful when hold.
        // If the model returned "warm" with a reason, drop it.
        hold_reason:
          r.intro_recommendation === "hold"
            ? (r.hold_reason ?? "").trim().slice(0, 260)
            : "",
        ...(typeof sectorFit === "number" ? { sector_fit: sectorFit } : {}),
      };
    });
  } catch (err) {
    logger.warn({ err }, "rerank fell back to retrieval order");
    return cheapFallbackRank(head, state, userTurn);
  }
}
