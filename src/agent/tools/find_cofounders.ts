import { z } from "zod";
import type { ToolParameterSchema } from "../../llm/provider.js";
import type { SearchStateRow } from "../../conversation/store.js";
import type { CandidateCard, RankedResult } from "../../matching/pipeline.js";

const FindCofoundersInputSchema = z.object({
  query: z.string().min(1),
});

export interface FindCofoundersDeps {
  requesterId: string;
  conversationId: string;
  getState: (convId: string) => Promise<SearchStateRow>;
  getShownFounderIds: (convId: string) => Promise<string[]>;
  runMatching: (args: {
    requesterId: string;
    state: SearchStateRow;
    userTurn: string;
    alreadyShownFounderIds: string[];
  }) => Promise<RankedResult>;
  recordShown: (convId: string, cards: CandidateCard[]) => Promise<boolean>;
}

export interface FindCofoundersFounder {
  id: string;
  name: string;
  city: string;
  headline: string;
  summary: string;
  bullets: string[];
  rationale: string;
  sector_tags: string[];
  stage_tags: string[];
  seniority: string;
  years_exp: number;
  fit: "warm" | "hold";
  /** 0-100. Use this in your reply so the founder sees a real, grounded
   *  number — e.g. "84% match — strongest sector overlap of the 5 we ranked". */
  match_score?: number;
  /** Per-axis 0-3 breakdown. Reference these explicitly when the founder
   *  asks "why this person?" or pushes back. */
  breakdown?: {
    role_fit?: number | undefined;
    reciprocal_fit?: number | undefined;
    sector_fit?: number | undefined;
    stage_fit?: number | undefined;
    location_fit?: number | undefined;
    anti_pref?: number | undefined;
  };
  /** Verbatim phrases from the candidate's profile. Quote them when the
   *  founder questions a claim — never paraphrase a fact you didn't have. */
  headline_evidence?: string[];
  /** How many times this candidate has been surfaced before, across the
   *  whole cohort. Use only when low (≤2) to say "fresh face". Don't
   *  call out high counts — that's our internal signal. */
  times_shown?: number;
  /** Drawback text from the reranker. Surface honestly when the founder
   *  asks for the downside. Empty string means there's no honest concern. */
  drawback?: string;
  /** Hold reason text from the reranker, only set when fit=hold. */
  hold_reason?: string;
}

export interface FindCofoundersResult {
  founder: FindCofoundersFounder | null;
  message?: string;
}

export async function handleFindCofounders(
  input: unknown,
  deps: FindCofoundersDeps,
): Promise<FindCofoundersResult> {
  const parsed = FindCofoundersInputSchema.parse(input);

  const state = await deps.getState(deps.conversationId);
  const shown = await deps.getShownFounderIds(deps.conversationId);

  const { cards } = await deps.runMatching({
    requesterId: deps.requesterId,
    state,
    userTurn: parsed.query,
    alreadyShownFounderIds: shown,
  });

  const top = cards[0];
  if (!top) {
    return {
      founder: null,
      message: "No matches in the cohort for this ask.",
    };
  }

  // Record only the single card we're showing
  await deps.recordShown(deps.conversationId, [top]);

  return {
    founder: {
      id: top.founder_id,
      name: top.name,
      city: top.city,
      headline: top.headline,
      summary: top.summary,
      bullets: top.bullets,
      rationale: top.rationale,
      sector_tags: top.sector_tags,
      stage_tags: top.stage_tags,
      seniority: top.seniority,
      years_exp: top.years_exp,
      fit: top.intro_recommendation,
      drawback: top.drawback,
      hold_reason: top.hold_reason,
      ...(typeof top.match_score === "number" ? { match_score: top.match_score } : {}),
      ...(top.breakdown ? { breakdown: top.breakdown } : {}),
      ...(top.headline_evidence?.length ? { headline_evidence: top.headline_evidence } : {}),
      ...(typeof top.times_shown === "number" ? { times_shown: top.times_shown } : {}),
    },
  };
}

export const findCofoundersSchema: ToolParameterSchema = {
  type: "object",
  properties: {
    query: {
      type: "string",
      description:
        "Natural-language description of who the user is looking for. Paraphrase the user's own words.",
    },
  },
  required: ["query"],
};
