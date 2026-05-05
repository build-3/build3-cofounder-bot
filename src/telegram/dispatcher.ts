// src/telegram/dispatcher.ts
import { logger } from "../lib/logger.js";
import {
  fetchFounderById,
  findFounderByTelegramChatId,
  findFounderByTelegramUsername,
  linkFounderTelegramChatId,
} from "../identity/gate.js";
import {
  getOrCreateConversation,
  getSearchState,
  getRecentTurns,
  insertInboundTurn,
  insertOutboundTurn,
  writeSearchState,
} from "../conversation/store.js";
import {
  getShownFounderIds,
  markShownAction,
  recordShown,
  runMatching,
} from "../matching/pipeline.js";
import { propose } from "../consent/machine.js";
import { getSql } from "../db/client.js";
import { loadConfig } from "../lib/config.js";
import { runAgent } from "../agent/loop.js";
import type { TelegramOutboundClient } from "./client.js";
import type { TelegramUpdate, TelegramUser } from "./types.js";

export interface TelegramDispatchDeps {
  tg: TelegramOutboundClient;
}

/**
 * Telegram inbound dispatcher. Mirrors src/wati/dispatcher.ts in shape and
 * invariants but uses Telegram-native identity (chat_id, username) instead
 * of E.164 phones.
 *
 * Identity flow on first contact:
 *   1. Look up founder by chat_id (already-linked, fast path).
 *   2. Fall back to username (the @handle, lower-cased).
 *   3. If found via username, persist chat_id for future turns.
 *   4. If still not found → silent drop (testing whitelist behavior).
 *
 * Idempotency: Telegram update_id is monotonically increasing per-bot and
 * unique across all updates. Reused as the wati_message_id slot on the
 * `turns.wati_message_id` unique index — keeps the existing schema.
 */
export async function dispatchTelegramUpdate(
  update: TelegramUpdate,
  deps: TelegramDispatchDeps,
): Promise<void> {
  const cfg = loadConfig();
  if (cfg.KILL_SWITCH) {
    logger.warn({ updateId: update.update_id }, "KILL_SWITCH active — dispatcher is a no-op");
    return;
  }

  // Extract the surface we care about. Two flavors:
  //   - update.message       → text message
  //   - update.callback_query → inline button tap
  const callback = update.callback_query;
  const message = update.message ?? callback?.message;
  if (!message) {
    logger.info({ updateId: update.update_id }, "telegram update has no message — drop");
    return;
  }

  const chatId = message.chat.id;
  const from: TelegramUser | undefined = update.message?.from ?? callback?.from;
  if (!from) {
    logger.info({ updateId: update.update_id, chatId }, "telegram update has no `from` — drop");
    return;
  }
  // Drop bot-to-bot traffic and unsupported chat types (groups/channels).
  if (from.is_bot) {
    logger.info({ updateId: update.update_id, fromId: from.id }, "ignoring bot message");
    return;
  }
  if (message.chat.type !== "private") {
    logger.info({ updateId: update.update_id, chatType: message.chat.type }, "ignoring non-private chat");
    return;
  }

  // The textual content. Either message.text or the callback_data string.
  const userText = callback?.data ?? update.message?.text ?? "";

  // Acknowledge the callback ASAP so the spinner stops on the user's side,
  // even if our agent loop is slow. Best-effort, never throws.
  if (callback) {
    await deps.tg.answerCallback(callback.id);
  }

  // Identity resolution. Try chat_id first (cheapest), then username.
  let founder = await findFounderByTelegramChatId(chatId);
  if (!founder && from.username) {
    founder = await findFounderByTelegramUsername(from.username);
    if (founder) {
      // First contact via username — persist chat_id for next turns.
      await linkFounderTelegramChatId(founder.id, chatId).catch((err) => {
        logger.warn({ err, founderId: founder?.id, chatId }, "linkFounderTelegramChatId failed (non-fatal)");
      });
    }
  }

  if (!founder) {
    // Friendly nudge for non-cohort senders. We don't drop silently here
    // (unlike WATI) because Telegram has no auto-reply intercept — the
    // founder will think the bot is broken if we say nothing.
    logger.info(
      { chatId, username: from.username, fromId: from.id },
      "telegram inbound but not in cohort — sending non-cohort nudge",
    );
    await deps.tg.sendTextByChatId({
      chatId,
      text:
        "Hey! This bot is for the Build3 cofounder cohort. " +
        "If you're part of the cohort and seeing this, ping the Build3 team to get linked.",
    });
    return;
  }
  if (!founder.optedIn) {
    logger.info({ founderId: founder.id, chatId }, "founder opted out — silent drop");
    return;
  }

  const conv = await getOrCreateConversation(founder.id);
  const sql = getSql();

  // Idempotency lock — same pattern as WATI dispatcher. update_id is unique
  // across all updates the bot ever receives, so it's a safe lock holder.
  const lockHolder = String(update.update_id);
  const acquired = await sql<Array<{ conversation_id: string }>>`
    INSERT INTO dispatch_locks (conversation_id, held_by, acquired_at)
    VALUES (${conv.id}, ${lockHolder}, now())
    ON CONFLICT (conversation_id) DO UPDATE
      SET held_by = EXCLUDED.held_by, acquired_at = EXCLUDED.acquired_at
      WHERE dispatch_locks.acquired_at < now() - interval '30 seconds'
    RETURNING conversation_id
  `;
  if (acquired.length === 0) {
    logger.info({ convId: conv.id, updateId: update.update_id }, "sibling lock held — no-op");
    return;
  }

  try {
    const inserted = await insertInboundTurn({
      conversationId: conv.id,
      // Reuse wati_message_id slot for Telegram update_id. Prefix with 'tg:'
      // so the namespace is unambiguous and a future hybrid deploy can't
      // collide if WATI ever sends a numeric-string id.
      watiMessageId: `tg:${lockHolder}`,
      text: userText || "(empty)",
      intent: "agent",
    });
    if (!inserted) {
      logger.info({ updateId: update.update_id }, "duplicate telegram update — no-op");
      return;
    }

    // The agent loop expects a WATI-shaped client (sendText/sendButtons by
    // waId). The Telegram client implements that surface, resolving waId
    // (founder.phone) → chat_id internally. Founder.phone is set on every
    // ingested row, so the lookup always succeeds for whitelisted founders.
    await runAgent({
      founder,
      conversationId: conv.id,
      userTurn: userText,
      wati: deps.tg,
      deps: {
        getSearchState,
        writeSearchState,
        getRecentTurns,
        getShownFounderIds,
        runMatching,
        recordShown,
        markShownAction,
        fetchFounderDetail: fetchFounderById,
        insertOutboundTurn,
        propose: async (args) => {
          await propose({ ...args, wati: deps.tg });
        },
      },
    });
  } finally {
    await sql`DELETE FROM dispatch_locks WHERE conversation_id = ${conv.id} AND held_by = ${lockHolder}`;
  }
}
