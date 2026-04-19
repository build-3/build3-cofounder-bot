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

  app.post("/wati", async (_req, reply) => {
    // KILL SWITCH: webhook disabled. Ack WATI so it stops retrying, but
    // do not dispatch anything. Remove this block to re-enable.
    reply.code(200).send({ ok: true, disabled: true });
  });
  void cfg; void wati; void WatiInboundSchema; void dispatchInbound;
  void UnauthorizedError; void ValidationError;
};
