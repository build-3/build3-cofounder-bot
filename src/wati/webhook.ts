import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import { loadConfig } from "../lib/config.js";
import { logger } from "../lib/logger.js";
import { UnauthorizedError, ValidationError } from "../lib/errors.js";
import { createWatiClient } from "./client.js";
import { dispatchInbound } from "./dispatcher.js";
import { WatiInboundSchema } from "./types.js";

/**
 * POST /webhooks/wati
 *
 * Contract:
 *  - Shared-secret auth via X-Webhook-Secret header OR ?secret= query param
 *    (WATI's UI can configure either).
 *  - Validate payload with Zod.
 *  - Await dispatch before replying. On Vercel serverless the function is
 *    frozen the moment the response is sent, so fire-and-forget would chop
 *    LLM calls mid-flight — which is what caused WATI to retry aggressively
 *    and bombard a founder with ~50 messages on 2026-04-19.
 *  - On any error, still return 200 so WATI doesn't retry. Errors are logged
 *    and the dispatcher has its own graceful fallback.
 *  - KILL_SWITCH env flag short-circuits here — the webhook still acks WATI
 *    so retries stop, but nothing downstream runs.
 */
export const watiWebhookRoute: FastifyPluginAsync = async (app: FastifyInstance) => {
  const cfg = loadConfig();
  const wati = createWatiClient();

  app.post("/wati", async (req, reply) => {
    if (cfg.KILL_SWITCH) {
      logger.warn("KILL_SWITCH active — webhook is a no-op");
      reply.code(200).send({ ok: true, disabled: true });
      return;
    }

    const headerSecret = req.headers["x-webhook-secret"];
    const querySecret = (req.query as { secret?: string } | undefined)?.secret;
    const provided = typeof headerSecret === "string" ? headerSecret : querySecret;
    if (provided !== cfg.WATI_WEBHOOK_SECRET) {
      throw new UnauthorizedError("invalid webhook secret");
    }

    const parsed = WatiInboundSchema.safeParse(req.body);
    if (!parsed.success) {
      logger.warn({ issues: parsed.error.issues, body: req.body }, "invalid WATI payload");
      throw new ValidationError("invalid WATI inbound payload");
    }

    try {
      await dispatchInbound(parsed.data, { wati });
    } catch (err) {
      // Dispatcher already handles its own errors and sends a recovery reply.
      // This catch is a last-line guard so we never 500 back to WATI (which
      // would trigger its retry storm).
      logger.error({ err, id: parsed.data.id, waId: parsed.data.waId }, "dispatchInbound unhandled");
    }

    reply.code(200).send({ ok: true });
  });
};
