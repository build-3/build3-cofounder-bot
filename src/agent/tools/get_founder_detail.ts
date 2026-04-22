import { z } from "zod";
import type { ToolParameterSchema } from "../../llm/provider.js";

const GetFounderDetailInputSchema = z.object({
  founder_id: z.string().uuid(),
});

export interface FounderDetail {
  name: string;
  city: string;
  headline: string;
  summary: string;
  role_tags: string[];
  sector_tags: string[];
  stage_tags: string[];
  seniority: string;
}

export interface GetFounderDetailDeps {
  fetchFounder: (id: string) => Promise<FounderDetail | null>;
}

export async function handleGetFounderDetail(
  input: unknown,
  deps: GetFounderDetailDeps,
): Promise<FounderDetail | { error: string }> {
  const parsed = GetFounderDetailInputSchema.parse(input);
  const founder = await deps.fetchFounder(parsed.founder_id);
  if (!founder) return { error: "founder not found" };
  return founder;
}

export const getFounderDetailSchema: ToolParameterSchema = {
  type: "object",
  properties: {
    founder_id: {
      type: "string",
      description: "UUID of a founder previously returned by find_cofounders.",
    },
  },
  required: ["founder_id"],
};
