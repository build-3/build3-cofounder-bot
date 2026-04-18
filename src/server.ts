import Fastify from "fastify";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import { loadConfig } from "./lib/config.js";
import { AppError } from "./lib/errors.js";
import { watiWebhookRoute } from "./wati/webhook.js";
import { adminRoutes } from "./admin/routes.js";
import { startExpiryJob } from "./consent/expiries.js";
import { createWatiClient } from "./wati/client.js";

async function buildServer() {
  const cfg = loadConfig();

  const app = Fastify({
    // Fastify expects logger options or a boolean, not a pino instance; we use
    // the module-level pino logger directly elsewhere. Level mirrors config.
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

async function main() {
  const { app, cfg } = await buildServer();
  // Consent expiry job runs in-process every 15 min.
  startExpiryJob(createWatiClient());
  try {
    await app.listen({ port: cfg.PORT, host: "0.0.0.0" });
  } catch (err) {
    app.log.error({ err }, "failed to start server");
    process.exit(1);
  }
}

// Only start when invoked directly (not during tests / imports)
if (import.meta.url === `file://${process.argv[1]}`) {
  void main();
}

export { buildServer };
