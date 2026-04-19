import Fastify, { type FastifyInstance } from "fastify";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import { loadConfig } from "./lib/config.js";
import { AppError } from "./lib/errors.js";
import { watiWebhookRoute } from "./wati/webhook.js";
import { adminRoutes } from "./admin/routes.js";

// buildServer is pure construction. No app.listen, no side-effect timers —
// those live in src/local.ts (local dev) and src/index.ts (Vercel entry)
// respectively, so tests and serverless builds don't pull them in.
export async function buildServer(): Promise<{ app: FastifyInstance; cfg: ReturnType<typeof loadConfig> }> {
  const cfg = loadConfig();

  const app = Fastify({
    logger: { level: cfg.LOG_LEVEL },
    trustProxy: true,
    disableRequestLogging: false,
    bodyLimit: 1_048_576, // 1 MB — WATI payloads are tiny
  });

  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(rateLimit, {
    max: 300,
    timeWindow: "1 minute",
    // Webhook traffic is bursty; WATI retries — don't 429 the webhook path.
    allowList: (req) => req.url.startsWith("/webhooks/"),
  });

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

  await app.register(watiWebhookRoute, { prefix: "/webhooks" });
  await app.register(adminRoutes, { prefix: "/admin" });

  return { app, cfg };
}
