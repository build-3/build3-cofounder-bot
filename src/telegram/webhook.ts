import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import { loadConfig } from "../lib/config.js";
import { logger } from "../lib/logger.js";
import { UnauthorizedError } from "../lib/errors.js";
import { createTelegramClient } from "./client.js";
import { dispatchTelegramUpdate } from "./dispatcher.js";
import { TelegramUpdateSchema } from "./types.js";

/**
 * POST /webhooks/telegram
 *
 * Telegram delivers Updates over HTTPS POST. Auth pattern is a
 * shared-secret token sent back in `X-Telegram-Bot-Api-Secret-Token` on
 * every delivery, configured at setWebhook time. We compare against
 * TELEGRAM_WEBHOOK_SECRET and 401 on mismatch.
 *
 * On any successful 200 Telegram considers the update delivered and never
 * retries. So:
 *  - Auth failure → 401 (Telegram pauses delivery — desired during dev).
 *  - Schema mismatch → log + 200 (we don't want unknown update types to
 *    cause Telegram to mark the webhook unhealthy).
 *  - Dispatch error → log + 200 (the dispatcher has its own fallback).
 *
 * Telegram has a hard 60-second response timeout. Vercel serverless gives
 * us 60s on the function — same as WATI, so the long-LLM-call risk profile
 * is identical. Always await dispatch before responding.
 */
export const telegramWebhookRoute: FastifyPluginAsync = async (app: FastifyInstance) => {
  const cfg = loadConfig();
  if (!cfg.TELEGRAM_BOT_TOKEN || !cfg.TELEGRAM_WEBHOOK_SECRET) {
    logger.warn("Telegram secrets missing — /webhooks/telegram will reject all traffic");
    app.post("/telegram", async (_req, reply) => {
      reply.code(503).send({ error: "TELEGRAM_NOT_CONFIGURED" });
    });
    return;
  }

  const tg = createTelegramClient();
  const tgSecret = cfg.TELEGRAM_WEBHOOK_SECRET; // narrow once after the guard above

  app.post("/telegram", async (req, reply) => {
    if (cfg.KILL_SWITCH) {
      logger.warn("KILL_SWITCH active — Telegram webhook is a no-op");
      reply.code(200).send({ ok: true, disabled: true });
      return;
    }

    const provided = req.headers["x-telegram-bot-api-secret-token"];
    if (typeof provided !== "string" || provided !== tgSecret) {
      logger.warn(
        {
          hasHeader: typeof provided === "string",
          providedLen: typeof provided === "string" ? provided.length : 0,
          expectedLen: tgSecret.length,
        },
        "telegram webhook secret mismatch",
      );
      throw new UnauthorizedError("invalid telegram webhook secret");
    }

    const parsed = TelegramUpdateSchema.safeParse(req.body);
    if (!parsed.success) {
      // Same posture as the WATI fix: ack 200 on unknown shapes so Telegram
      // doesn't suspend the webhook. Real failures are logged.
      logger.warn(
        { issues: parsed.error.issues, body: req.body },
        "Telegram payload outside schema — dropping (200 ack)",
      );
      reply.code(200).send({ ok: true, ignored: "schema_mismatch" });
      return;
    }

    try {
      await dispatchTelegramUpdate(parsed.data, { tg });
    } catch (err) {
      logger.error({ err, updateId: parsed.data.update_id }, "dispatchTelegramUpdate unhandled");
    }

    reply.code(200).send({ ok: true });
  });
};
