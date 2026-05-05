import { z } from "zod";

/**
 * Subset of the Telegram Bot API Update object we actually consume. The full
 * shape is huge (https://core.telegram.org/bots/api#update); we only parse
 * the two flavors the bot reacts to:
 *
 *  - `message` with text → a regular customer message (the common case).
 *  - `callback_query` → user tapped an inline keyboard button.
 *
 * Everything else (edited_message, channel_post, my_chat_member, ...) is
 * accepted by `.passthrough()` at the top level and ignored downstream —
 * the dispatcher treats unknown shapes as no-ops and acks 200.
 *
 * Idempotency: `update_id` is monotonically increasing per-bot, unique
 * across all updates ever delivered. We use it the same way wati_message_id
 * is used today (unique index on turns).
 */

const TelegramUserSchema = z
  .object({
    id: z.number().int(),
    is_bot: z.boolean().optional(),
    first_name: z.string().optional(),
    last_name: z.string().optional(),
    username: z.string().optional(),     // the @handle (no leading @)
    language_code: z.string().optional(),
  })
  .passthrough();

const TelegramChatSchema = z
  .object({
    id: z.number().int(),                // chat.id == user.id for 1:1 DMs
    type: z.string(),                    // "private" | "group" | "supergroup" | "channel"
    username: z.string().optional(),
    first_name: z.string().optional(),
    last_name: z.string().optional(),
  })
  .passthrough();

const TelegramMessageSchema = z
  .object({
    message_id: z.number().int(),
    date: z.number().int(),              // unix seconds
    chat: TelegramChatSchema,
    from: TelegramUserSchema.optional(), // absent on channel posts
    text: z.string().optional(),
    // Many other fields (photo, document, voice, ...) we ignore.
  })
  .passthrough();

const TelegramCallbackQuerySchema = z
  .object({
    id: z.string().min(1),               // unique per-callback, used in answerCallbackQuery
    from: TelegramUserSchema,
    message: TelegramMessageSchema.optional(),
    data: z.string().optional(),         // the callback_data we set on the button
  })
  .passthrough();

export const TelegramUpdateSchema = z
  .object({
    update_id: z.number().int(),
    message: TelegramMessageSchema.optional(),
    callback_query: TelegramCallbackQuerySchema.optional(),
  })
  .passthrough();

export type TelegramUpdate = z.infer<typeof TelegramUpdateSchema>;
export type TelegramMessage = z.infer<typeof TelegramMessageSchema>;
export type TelegramCallbackQuery = z.infer<typeof TelegramCallbackQuerySchema>;
export type TelegramUser = z.infer<typeof TelegramUserSchema>;

/**
 * Outbound shapes used by the client. Mirrors WATI's outbound surface so the
 * agent loop and consent machine can stay transport-agnostic — they call
 * sendText / sendButtons on whatever client they're handed.
 *
 * `chatId` is the Telegram chat.id (a numeric primitive, not a string). The
 * legacy WATI client uses `waId` (string, E.164). The shared agent surface
 * is widened to accept either via an interface in `./client.ts`.
 */
export interface SendTextArgs {
  chatId: number;
  text: string;
}

export interface SendButtonsArgs {
  chatId: number;
  body: string;
  /** Up to 3 inline buttons, mirroring WATI's button cap. */
  buttons: Array<{ text: string; payload?: string }>;
}
