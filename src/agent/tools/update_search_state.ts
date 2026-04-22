import { z } from "zod";
import type { ToolParameterSchema } from "../../llm/provider.js";
import type { SearchStateRow } from "../../conversation/store.js";

const DeltaSchema = z.object({
  role: z.string().nullable().optional(),
  sector: z.array(z.string()).optional(),
  stage: z.array(z.string()).optional(),
  location: z.array(z.string()).optional(),
  seniority: z.string().nullable().optional(),
  must_have: z.array(z.string()).optional(),
  nice_to_have: z.array(z.string()).optional(),
  anti_prefs: z.array(z.string()).optional(),
});

export interface UpdateSearchStateDeps {
  conversationId: string;
  getState: (convId: string) => Promise<SearchStateRow>;
  writeState: (state: SearchStateRow) => Promise<void>;
}

export interface UpdateSearchStateResult {
  updated: SearchStateRow;
}

export async function handleUpdateSearchState(
  input: unknown,
  deps: UpdateSearchStateDeps,
): Promise<UpdateSearchStateResult> {
  const delta = DeltaSchema.parse(input);
  const current = await deps.getState(deps.conversationId);
  const updated: SearchStateRow = {
    ...current,
    ...(delta.role !== undefined ? { role: delta.role } : {}),
    ...(delta.sector !== undefined ? { sector: delta.sector } : {}),
    ...(delta.stage !== undefined ? { stage: delta.stage } : {}),
    ...(delta.location !== undefined ? { location: delta.location } : {}),
    ...(delta.seniority !== undefined ? { seniority: delta.seniority } : {}),
    ...(delta.must_have !== undefined ? { mustHave: delta.must_have } : {}),
    ...(delta.nice_to_have !== undefined ? { niceToHave: delta.nice_to_have } : {}),
    ...(delta.anti_prefs !== undefined ? { antiPrefs: delta.anti_prefs } : {}),
  };
  await deps.writeState(updated);
  return { updated };
}

export const updateSearchStateSchema: ToolParameterSchema = {
  type: "object",
  properties: {
    role: { type: "string", description: "Role the user wants in a cofounder (e.g. 'technical', 'sales', 'growth')." },
    sector: { type: "array", items: { type: "string" }, description: "Sectors (e.g. ['b2b-saas', 'fintech'])." },
    stage: { type: "array", items: { type: "string" }, description: "Company stages (e.g. ['pre-seed', 'seed'])." },
    location: { type: "array", items: { type: "string" }, description: "Cities/regions (e.g. ['Bangalore'])." },
    seniority: { type: "string", description: "Experience level (e.g. 'founder-level', 'senior')." },
    must_have: { type: "array", items: { type: "string" }, description: "Hard requirements in natural language." },
    nice_to_have: { type: "array", items: { type: "string" }, description: "Soft preferences." },
    anti_prefs: { type: "array", items: { type: "string" }, description: "Things the user does NOT want." },
  },
};
