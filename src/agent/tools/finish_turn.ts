import { z } from "zod";
import type { ToolParameterSchema } from "../../llm/provider.js";
import type { AgentButton } from "../types.js";

const ButtonSchema = z.object({
  id: z.string().min(1).max(64),
  title: z.string().min(1).max(20),
});

const FinishTurnInputSchema = z.object({
  reply: z.string().min(1, "empty reply"),
  buttons: z.array(ButtonSchema).max(2, "max 2 buttons (WATI session cap)").optional(),
});

export interface FinishTurnResult {
  reply: string;
  buttons?: AgentButton[];
  cleanFinish: true;
}

export function handleFinishTurn(input: unknown): FinishTurnResult {
  const parsed = FinishTurnInputSchema.parse(input);
  return {
    reply: parsed.reply,
    ...(parsed.buttons ? { buttons: parsed.buttons } : {}),
    cleanFinish: true,
  };
}

export const finishTurnSchema: ToolParameterSchema = {
  type: "object",
  properties: {
    reply: {
      type: "string",
      description: "The WhatsApp message to send to the user. Your user-facing reply.",
    },
    buttons: {
      type: "array",
      description: "Optional interactive buttons (max 2). Use ids like 'accept', 'skip', 'force_intro'.",
    },
  },
  required: ["reply"],
};
