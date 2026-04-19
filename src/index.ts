// Vercel entry. The Vercel Fastify framework preset auto-detects a file
// named src/index.ts with a default-exported FastifyInstance and wires it
// into the serverless runtime. The preset invokes `await app.ready()`
// before the first request, which drains the queued `app.register(...)`
// calls below — so this file stays fully synchronous at the top level.
//
// No app.listen(): the serverless runtime invokes handlers directly.
// No startup timers: they'd run per-cold-start and leak resources.
// Background work (consent expiries) will run via Vercel Cron.

import Fastify, { type FastifyInstance } from "fastify";
import helmet from "@fastify/helmet";
import { loadConfig } from "./lib/config.js";
import { AppError } from "./lib/errors.js";
import { watiWebhookRoute } from "./wati/webhook.js";
import { adminRoutes } from "./admin/routes.js";

const cfg = loadConfig();

const app: FastifyInstance = Fastify({
  logger: { level: cfg.LOG_LEVEL },
  trustProxy: true,
  disableRequestLogging: false,
  bodyLimit: 1_048_576,
});

// Queue plugin registration — Fastify drains this in app.ready().
// Rate-limiting intentionally lives at the Vercel edge (or a future
// middleware) rather than in-process: @fastify/rate-limit's in-memory store
// holds state per-isolate, which is meaningless on a scale-to-zero runtime.
app.register(helmet, { contentSecurityPolicy: false });

app.setErrorHandler((err, _req, reply) => {
  if (err instanceof AppError) {
    return reply.status(err.statusCode).send({
      error: err.code,
      message: err.message,
      details: err.details ?? null,
    });
  }
  app.log.error({ err }, "unhandled error");
  return reply.status(500).send({ error: "INTERNAL", message: "internal server error" });
});

app.get("/healthz", async () => ({ ok: true, ts: new Date().toISOString() }));

app.register(watiWebhookRoute, { prefix: "/webhooks" });
app.register(adminRoutes, { prefix: "/admin" });

export default app;
