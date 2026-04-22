import { z } from "zod";
import type { ToolParameterSchema } from "../../llm/provider.js";

const ProposeIntroInputSchema = z.object({
  target_founder_id: z.string().uuid(),
  requester_note: z.string().min(1).max(280),
});

export interface ProposeIntroDeps {
  requesterId: string;
  propose: (args: { requesterId: string; targetId: string; requesterNote: string }) => Promise<void>;
  markAccepted: (founderId: string) => Promise<void>;
}

export interface ProposeIntroResult {
  status: "proposed" | "error";
  message: string;
}

export async function handleProposeIntro(
  input: unknown,
  deps: ProposeIntroDeps,
): Promise<ProposeIntroResult> {
  const parsed = ProposeIntroInputSchema.parse(input);
  try {
    await deps.propose({
      requesterId: deps.requesterId,
      targetId: parsed.target_founder_id,
      requesterNote: parsed.requester_note,
    });
    await deps.markAccepted(parsed.target_founder_id);
    return { status: "proposed", message: "Intro request sent to the target." };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown error";
    return { status: "error", message: msg };
  }
}

export const proposeIntroSchema: ToolParameterSchema = {
  type: "object",
  properties: {
    target_founder_id: {
      type: "string",
      description:
        "UUID of the founder the user wants an intro to. Must be someone find_cofounders returned this conversation.",
    },
    requester_note: {
      type: "string",
      description:
        "1-2 sentences the requester sends along — why they want to talk. DO NOT include any personal info beyond the requester's name/city which the target already gets automatically.",
    },
  },
  required: ["target_founder_id", "requester_note"],
};
