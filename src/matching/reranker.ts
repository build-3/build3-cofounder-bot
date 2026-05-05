import { z } from "zod";
import { getLLM } from "../llm/index.js";
import { loadConfig } from "../lib/config.js";
import { logger } from "../lib/logger.js";
import {
  buildRerankUserPrompt,
  RERANK_SYSTEM,
  type RerankCandidate,
} from "../llm/prompts/rerank_v5.js";
import type { SearchStateRow } from "../conversation/store.js";
import type { RetrievedCandidate } from "./retriever.js";

function rerankModel(): string | undefined {
  // Tests stub the LLM provider before calling rerank, but they don't bring
  // up the full env. loadConfig() throws on missing required envs, so we
  // swallow that here — undefined falls through to the provider's default
  // chat model, which is the right behavior in tests.
  try {
    const cfg = loadConfig();
    return cfg.LLM_PROVIDER === "openai" ? cfg.OPENAI_MODEL_RERANK : cfg.GEMINI_MODEL_RERANK;
  } catch {
    return undefined;
  }
}

const BreakdownSchema = z
  .object({
    role_fit: z.number(),
    reciprocal_fit: z.number(),
    sector_fit: z.number(),
    stage_fit: z.number(),
    location_fit: z.number(),
    anti_pref: z.number(),
  })
  .partial()
  .optional();

const RerankOutputSchema = z.object({
  ranked: z.array(
    z.object({
      founder_id: z.string().uuid(),
      score: z.number(),
      rationale: z.string().min(1).max(280),
      bullets: z.array(z.string().max(200)).max(4).default([]),
      drawback: z.string().max(240).default(""),
      intro_recommendation: z.enum(["warm", "hold"]).default("warm"),
      hold_reason: z.string().max(260).default(""),
      breakdown: BreakdownSchema,
      // v5 additions. Defaulted so a v4-shaped response still parses.
      match_score: z.number().min(0).max(100).optional(),
      headline_evidence: z.array(z.string().max(120)).max(4).default([]),
    }),
  ),
});

/** Recompute match_score from breakdown using the exact formula the prompt
 *  hands to the model. Used as a fallback when the model omits the field
 *  (e.g. the response was shaped by a cached older prompt). */
function deriveMatchScore(b: z.infer<typeof BreakdownSchema>): number | undefined {
  if (!b) return undefined;
  const r = b.role_fit ?? 0;
  const rec = b.reciprocal_fit ?? 0;
  const s = b.sector_fit ?? 0;
  const st = b.stage_fit ?? 0;
  const l = b.location_fit ?? 0;
  const anti = b.anti_pref ?? 0;
  const raw = r * 3 + rec * 2 + s * 2 + st + l - anti;
  return Math.max(0, Math.min(100, Math.round((100 * raw) / 27)));
}

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
   *  entirely and the caller should be honest about the gap. */
  sector_fit?: number;
  /** 0-100 quantitative match score. Surfaced to the user on the card. */
  match_score?: number;
  /** 0-3 each. The full breakdown so the dispatcher can render a "why"
   *  block when the user asks. */
  breakdown?: {
    role_fit?: number | undefined;
    reciprocal_fit?: number | undefined;
    sector_fit?: number | undefined;
    stage_fit?: number | undefined;
    location_fit?: number | undefined;
    anti_pref?: number | undefined;
  };
  /** Verbatim phrases from the candidate profile justifying the score. */
  headline_evidence?: string[];
}

// Smaller candidate set (was 5) — the rerank latency is ~linear in
// candidates × output tokens, and 4 cards still gives the agent room for
// "next" / "skip" without recomputing. Empirically, the top-of-rank
// distribution after retrieval is dominated by the first 3-4 anyway.
const TOP_N_TO_RERANK = 4;
const RETURN_TOP = 3;
// 25s ceiling. With gpt-4.1-mini and 4 candidates a healthy rerank lands in
// 6-9s; the timeout is a guard against transient upstream slowness, after
// which we fall back to retrieval order rather than block the WhatsApp turn.
const RERANK_TIMEOUT_MS = 25_000;
// 4 candidates × ~280 tokens (rationale + 3 bullets + breakdown + 3 evidence
// quotes + drawback) = ~1.1k. 1300 gives slack so the JSON closes cleanly.
// Lower than this and gpt-4.1-mini truncates mid-object → parse fails
// silently and we lose the v5 quantitative fields.
const RERANK_MAX_TOKENS = 1300;

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
    years_exp: c.years_exp,
    times_shown: c.times_shown,
  }));

  try {
    const model = rerankModel();
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
      ...(model ? { model } : {}),
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
      const matchScore = r.match_score ?? deriveMatchScore(r.breakdown);
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
        hold_reason:
          r.intro_recommendation === "hold"
            ? (r.hold_reason ?? "").trim().slice(0, 260)
            : "",
        ...(typeof sectorFit === "number" ? { sector_fit: sectorFit } : {}),
        ...(typeof matchScore === "number" ? { match_score: matchScore } : {}),
        ...(r.breakdown ? { breakdown: r.breakdown } : {}),
        headline_evidence: (r.headline_evidence ?? [])
          .map((e) => e.trim())
          .filter((e) => e.length > 0)
          .slice(0, 3),
      };
    });
  } catch (err) {
    logger.warn({ err }, "rerank fell back to retrieval order");
    return cheapFallbackRank(head, state, userTurn);
  }
}
