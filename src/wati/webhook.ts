import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import { loadConfig } from "../lib/config.js";
import { UnauthorizedError, ValidationError } from "../lib/errors.js";
import { createWatiClient } from "./client.js";
import { dispatchInbound } from "./dispatcher.js";
import { WatiInboundSchema } from "./types.js";

/**
 * POST /webhooks/wati
 * - Shared-secret header auth
 * - Parse + idempotent dispatch
 * - Returns 200 fast; dispatch runs asynchronously so WATI doesn't retry on slow LLM calls.
 *
 * Idempotency is enforced at the DB (`turns.wati_message_id` unique), not here,
 * so an async dispatch is safe: a second redelivery will be a no-op.
 */
export const watiWebhookRoute: FastifyPluginAsync = async (app: FastifyInstance) => {
  const cfg = loadConfig();
  const wati = createWatiClient();

  app.post("/wati", async (req, reply) => {
    const headerSecret = req.headers["x-webhook-secret"];
    const querySecret = (req.query as Record<string, string>).secret;
    const secret = headerSecret ?? querySecret;
    if (typeof secret !== "string" || secret !== cfg.WATI_WEBHOOK_SECRET) {
      throw new UnauthorizedError("bad webhook secret");
    }

    app.log.info({ body: req.body }, "wati raw payload");

    const parsed = WatiInboundSchema.safeParse(req.body);
    if (!parsed.success) {
      app.log.warn({ body: req.body, issues: parsed.error.issues }, "wati payload validation failed");
      throw new ValidationError("invalid WATI payload", {
        issues: parsed.error.issues.map((i) => ({
          path: i.path.join("."),
          message: i.message,
        })),
      });
    }

    // Ack fast. Dispatch async; failures are logged but don't leak a 500 to WATI
    // (which would trigger a retry and risk double-delivery if idempotency ever missed).
    reply.code(200).send({ ok: true });

    queueMicrotask(async () => {
      try {
        await dispatchInbound(parsed.data, { wati });
      } catch (err) {
        app.log.error({ err, watiMessageId: parsed.data.id }, "dispatchInbound failed");
      }
    });
  });
};
