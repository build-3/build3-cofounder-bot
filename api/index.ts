// Vercel serverless entry. Vercel auto-routes /api/* to this file when
// deployed with the default Node runtime; `vercel.json` adds a rewrite so
// every request (including /webhooks/wati and /healthz) lands here.
//
// Caveat — Fastify was designed for long-running hosts. On Vercel:
//   * the in-process consent-expiry setInterval does NOT run, since functions
//     are cold-started per request. Phase 6 follow-up: move expiries to a
//     Vercel Cron hitting POST /admin/run-expiries.
//   * each cold start pays Fastify's register() cost (~100ms). Cached once
//     warm, so the webhook path stays under WATI's timeout.

import type { IncomingMessage, ServerResponse } from "node:http";
import { buildServer } from "../src/server.js";

// Fastify v5 instances are thenable, which trips up Promise<FastifyInstance>
// chains. We only need the server emitter, so store a cached-init promise
// of `{ server }` — the shape of what we actually use.
type ReadyServer = { server: { emit: (ev: "request", req: IncomingMessage, res: ServerResponse) => void } };

let serverPromise: Promise<ReadyServer> | undefined;

function getServer(): Promise<ReadyServer> {
  if (!serverPromise) {
    serverPromise = (async () => {
      const { app } = await buildServer();
      await app.ready();
      return { server: app.server } satisfies ReadyServer;
    })();
  }
  return serverPromise;
}

export default async function handler(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const { server } = await getServer();
  server.emit("request", req, res);
}
