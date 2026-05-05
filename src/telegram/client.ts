import { loadConfig } from "../lib/config.js";
import { logger } from "../lib/logger.js";
import { findFounderByPhone } from "../identity/gate.js";
import { assertOutboundAllowed, RateLimitExceededError } from "../wati/rate-limit.js";
import type { WatiClient } from "../wati/client.js";
import type { SendTextArgs as TgSendTextArgs, SendButtonsArgs as TgSendButtonsArgs } from "./types.js";

/**
 * Telegram outbound client.
 *
 * Implements the WATI client surface (sendText / sendButtons / sendTemplate)
 * so the agent loop, consent machine, and expiry job stay transport-agnostic.
 * This means existing callers pass a WATI-shaped `waId` (E.164 phone, no plus)
 * and we resolve it to a Telegram chat_id via the founders table.
 *
 * Resolution failures (founder linked by phone but not by Telegram chat_id
 * yet) log a warning and silently no-op — better than throwing inside the
 * agent loop which would trigger the safety-net fallback.
 *
 * sendTemplate is a WATI concept (24h-window reopens via approved template).
 * Telegram has no equivalent — there is no "session window" — so we just
 * render the template name + parameters as plain text. Good enough for the
 * one place this is used (intro reopen reminders).
 */

export interface TelegramClient {
  /** Native chat-id surface — preferred from new Telegram code paths. */
  sendTextByChatId(args: TgSendTextArgs): Promise<void>;
  sendButtonsByChatId(args: TgSendButtonsArgs): Promise<void>;
  /** Acknowledge a callback_query so Telegram stops the spinner on the button. */
  answerCallback(callbackId: string, text?: string): Promise<void>;
}

export interface TelegramOutboundClient extends WatiClient, TelegramClient {}

const TG_BASE = "https://api.telegram.org";

async function withRetry(fn: () => Promise<Response>, label: string): Promise<Response> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fn();
      if (res.ok) return res;
      // 429 = Telegram rate limit. Respect Retry-After if present.
      if (res.status === 429) {
        const body = (await res.clone().json().catch(() => ({}))) as {
          parameters?: { retry_after?: number };
        };
        const retryAfterMs = (body.parameters?.retry_after ?? 1) * 1000;
        logger.warn({ label, attempt, retryAfterMs }, "Telegram 429 — backing off");
        await new Promise((r) => setTimeout(r, retryAfterMs));
        lastErr = new Error(`${label} 429`);
        continue;
      }
      // 4xx (other than 429): our bug, don't retry.
      if (res.status >= 400 && res.status < 500) {
        const body = await res.text().catch(() => "");
        throw new Error(`${label} ${res.status}: ${body.slice(0, 300)}`);
      }
      lastErr = new Error(`${label} ${res.status}`);
    } catch (err) {
      lastErr = err;
    }
    const backoffMs = 250 * 2 ** (attempt - 1);
    logger.warn({ label, attempt, backoffMs }, "Telegram call failed, retrying");
    await new Promise((r) => setTimeout(r, backoffMs));
  }
  throw lastErr instanceof Error ? lastErr : new Error(`${label} failed`);
}

export function createTelegramClient(): TelegramOutboundClient {
  const cfg = loadConfig();
  if (!cfg.TELEGRAM_BOT_TOKEN) {
    throw new Error("TELEGRAM_BOT_TOKEN is required to create a Telegram client");
  }
  const apiBase = `${TG_BASE}/bot${cfg.TELEGRAM_BOT_TOKEN}`;
  const headers = { "Content-Type": "application/json" };

  function guard(rateKey: string, label: string): boolean {
    if (cfg.KILL_SWITCH) {
      logger.warn({ rateKey, label }, "KILL_SWITCH active — dropping outbound");
      return false;
    }
    try {
      assertOutboundAllowed(rateKey);
      return true;
    } catch (err) {
      if (err instanceof RateLimitExceededError) return false;
      throw err;
    }
  }

  async function resolveChatId(waId: string): Promise<number | null> {
    const founder = await findFounderByPhone(waId);
    // findFounderByPhone returns Founder, but Founder doesn't carry the
    // Telegram chat_id. Look it up directly.
    if (!founder) return null;
    const { getSql } = await import("../db/client.js");
    const sql = getSql();
    const rows = await sql<Array<{ telegram_chat_id: number | null }>>`
      SELECT telegram_chat_id FROM founders WHERE id = ${founder.id} LIMIT 1
    `;
    return rows[0]?.telegram_chat_id ?? null;
  }

  async function sendTextRaw(chatId: number, text: string, label: string): Promise<void> {
    await withRetry(
      () =>
        fetch(`${apiBase}/sendMessage`, {
          method: "POST",
          headers,
          body: JSON.stringify({ chat_id: chatId, text, parse_mode: "Markdown" }),
        }),
      label,
    );
  }

  async function sendButtonsRaw(
    chatId: number,
    body: string,
    buttons: TgSendButtonsArgs["buttons"],
    label: string,
  ): Promise<void> {
    if (buttons.length === 0 || buttons.length > 3) {
      throw new Error(`Telegram inline keyboard expects 1–3 buttons; got ${buttons.length}`);
    }
    // One row, one button per cell — mirrors WhatsApp interactive button UX.
    const inline_keyboard = [
      buttons.map((b) => ({
        text: b.text,
        callback_data: (b.payload ?? b.text).slice(0, 64), // Telegram caps at 64 bytes
      })),
    ];
    await withRetry(
      () =>
        fetch(`${apiBase}/sendMessage`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            chat_id: chatId,
            text: body,
            parse_mode: "Markdown",
            reply_markup: { inline_keyboard },
          }),
        }),
      label,
    );
  }

  return {
    // ─── WATI-compatible surface (used by agent loop + consent machine) ───
    async sendText({ waId, text }) {
      if (!guard(waId, "tg.sendText")) return;
      const chatId = await resolveChatId(waId);
      if (chatId == null) {
        logger.warn({ waId }, "tg.sendText: no telegram_chat_id linked for this founder — dropping");
        return;
      }
      await sendTextRaw(chatId, text, "Telegram.sendText");
    },

    async sendButtons({ waId, body, buttons }) {
      if (!guard(waId, "tg.sendButtons")) return;
      const chatId = await resolveChatId(waId);
      if (chatId == null) {
        logger.warn({ waId }, "tg.sendButtons: no telegram_chat_id linked — dropping");
        return;
      }
      await sendButtonsRaw(chatId, body, buttons, "Telegram.sendButtons");
    },

    async sendTemplate({ waId, templateName, parameters }) {
      // Telegram has no template concept. Render as plain text.
      if (!guard(waId, "tg.sendTemplate")) return;
      const chatId = await resolveChatId(waId);
      if (chatId == null) return;
      const params = (parameters ?? []).map((p) => `${p.name}: ${p.value}`).join("\n");
      const text = params ? `[${templateName}]\n${params}` : `[${templateName}]`;
      await sendTextRaw(chatId, text, "Telegram.sendTemplate");
    },

    // ─── Native Telegram surface (used by the Telegram dispatcher) ────────
    async sendTextByChatId({ chatId, text }) {
      if (!guard(String(chatId), "tg.sendTextByChatId")) return;
      await sendTextRaw(chatId, text, "Telegram.sendTextByChatId");
    },

    async sendButtonsByChatId({ chatId, body, buttons }) {
      if (!guard(String(chatId), "tg.sendButtonsByChatId")) return;
      await sendButtonsRaw(chatId, body, buttons, "Telegram.sendButtonsByChatId");
    },

    async answerCallback(callbackId, text) {
      // Best-effort. Don't crash the dispatcher if Telegram is flaky here —
      // the worst case is the user sees a spinning button for ~15s before
      // Telegram times it out client-side.
      try {
        await withRetry(
          () =>
            fetch(`${apiBase}/answerCallbackQuery`, {
              method: "POST",
              headers,
              body: JSON.stringify({ callback_query_id: callbackId, ...(text ? { text } : {}) }),
            }),
          "Telegram.answerCallback",
        );
      } catch (err) {
        logger.warn({ err, callbackId }, "answerCallback failed — ignoring");
      }
    },
  };
}
