// Local-dev entrypoint. Never imported by the Vercel Fastify preset.
// Runs app.listen() on PORT and starts the in-process consent-expiry job.
// npm run dev → tsx watch src/local.ts
// npm run start (after build) → node dist/local.js

import { buildServer } from "./server.js";
import { startExpiryJob } from "./consent/expiries.js";
import { createWatiClient } from "./wati/client.js";

async function main(): Promise<void> {
  const { app, cfg } = await buildServer();
  // Consent expiry job runs in-process every 15 min (local only — on Vercel
  // this will be replaced by a Vercel Cron hitting /admin/run-expiries).
  startExpiryJob(createWatiClient());
  try {
    await app.listen({ port: cfg.PORT, host: "0.0.0.0" });
  } catch (err) {
    app.log.error({ err }, "failed to start server");
    process.exit(1);
  }
}

void main();
