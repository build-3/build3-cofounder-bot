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
