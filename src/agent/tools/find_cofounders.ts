import { z } from "zod";
import type { ToolParameterSchema } from "../../llm/provider.js";
import type { SearchStateRow } from "../../conversation/store.js";
import type { CandidateCard, RankedResult } from "../../matching/pipeline.js";

const FindCofoundersInputSchema = z.object({
  query: z.string().min(1),
  limit: z.number().int().min(1).optional(),
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
  rationale: string;
  fit: "warm" | "hold";
}

export interface FindCofoundersResult {
  founders: FindCofoundersFounder[];
  message?: string;
}

export async function handleFindCofounders(
  input: unknown,
  deps: FindCofoundersDeps,
): Promise<FindCofoundersResult> {
  const parsed = FindCofoundersInputSchema.parse(input);
  const limit = Math.min(parsed.limit ?? 3, 5);

  const state = await deps.getState(deps.conversationId);
  const shown = await deps.getShownFounderIds(deps.conversationId);

  const { cards } = await deps.runMatching({
    requesterId: deps.requesterId,
    state,
    userTurn: parsed.query,
    alreadyShownFounderIds: shown,
  });

  const top = cards.slice(0, limit);
  if (top.length === 0) {
    return {
      founders: [],
      message: "No matches in the cohort for this ask.",
    };
  }

  await deps.recordShown(deps.conversationId, top);

  return {
    founders: top.map((c) => ({
      id: c.founder_id,
      name: c.name,
      city: c.city,
      headline: c.headline,
      rationale: c.rationale,
      fit: c.intro_recommendation,
    })),
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
    limit: {
      type: "number",
      description: "How many candidates to return (default 3, max 5).",
    },
  },
  required: ["query"],
};
