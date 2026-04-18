import { z } from "zod";

/**
 * Inbound webhook payload subset we care about. WATI sends a fair amount of
 * metadata we don't use — `.passthrough()` accepts it without failing.
 */
export const WatiInboundSchema = z
  .object({
    id: z.string().min(1),                        // wati message id — idempotency key
    waId: z.string().min(1),                      // sender E.164 w/o '+'
    senderName: z.string().optional(),
    text: z.string().optional(),
    type: z.string().optional(),                  // 'text' | 'button' | 'interactive' | ...
    buttonPayload: z.string().optional(),
    interactive: z.unknown().optional(),
    timestamp: z.number().int().optional(),
  })
  .passthrough();

export type WatiInbound = z.infer<typeof WatiInboundSchema>;

export type InteractiveButton = { text: string; payload?: string };

export type OutboundKind = "text" | "buttons" | "template";

export interface SendTextArgs {
  waId: string;
  text: string;
}

export interface SendButtonsArgs {
  waId: string;
  body: string;
  buttons: InteractiveButton[];  // WATI caps at 3
}

export interface SendTemplateArgs {
  waId: string;
  templateName: string;
  parameters?: Array<{ name: string; value: string }>;
}
