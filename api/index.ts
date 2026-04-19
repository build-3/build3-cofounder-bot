// @vercel/node handler — deliberate escape hatch from the Vercel Fastify
// framework preset. The preset's auto-wired launcher hung app.ready() on
// our setup (observed: /healthz timed out at 60s with no runtime log output
// despite the exact same compiled bundle + prod env returning 200 in ~2ms
// via app.inject() locally). We now own the Node req/res wiring ourselves.
//
// Shape matches Vercel docs:
//   - Build the Fastify app once per cold start, cache it module-scope.
//   - Await app.ready() to drain plugin registrations.
//   - Hand raw (req, res) to fastify.server via the `request` event.
//
// The project's `framework` setting at the Vercel platform level must be
// `null` (Other), not "fastify", or the preset will override this handler.

import type { IncomingMessage, ServerResponse } from "node:http";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server.js";

let appPromise: Promise<FastifyInstance> | null = null;

function getApp(): Promise<FastifyInstance> {
  if (appPromise) return appPromise;
  appPromise = (async () => {
    const { app } = await buildServer();
    await app.ready();
    return app;
  })();
  return appPromise;
}

export default async function handler(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const app = await getApp();
  app.server.emit("request", req, res);
}
