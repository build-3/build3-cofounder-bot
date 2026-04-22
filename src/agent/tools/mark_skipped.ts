import { z } from "zod";
import type { ToolParameterSchema } from "../../llm/provider.js";

const MarkSkippedInputSchema = z.object({
  founder_id: z.string().uuid(),
});

export interface MarkSkippedDeps {
  conversationId: string;
  markShownAction: (convId: string, founderId: string, action: "accepted" | "skipped") => Promise<void>;
}

export async function handleMarkSkipped(
  input: unknown,
  deps: MarkSkippedDeps,
): Promise<{ ok: true }> {
  const parsed = MarkSkippedInputSchema.parse(input);
  await deps.markShownAction(deps.conversationId, parsed.founder_id, "skipped");
  return { ok: true };
}

export const markSkippedSchema: ToolParameterSchema = {
  type: "object",
  properties: {
    founder_id: {
      type: "string",
      description: "UUID of the founder the user is skipping. Typically the last one shown.",
    },
  },
  required: ["founder_id"],
};
