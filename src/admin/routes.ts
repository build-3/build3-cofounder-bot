import type { FastifyInstance, FastifyRequest } from "fastify";
import { loadConfig } from "../lib/config.js";
import { getSql } from "../db/client.js";
import { AppError } from "../lib/errors.js";
import { logger } from "../lib/logger.js";

/**
 * Admin routes. Auth is a single static bearer token (ADMIN_TOKEN). Intentionally
 * boring — these endpoints exist for operators to trigger seed ingest and peek
 * at counters, not to manage the product.
 *
 * All routes require header: `Authorization: Bearer $ADMIN_TOKEN`.
 */

function requireAdmin(req: FastifyRequest) {
  const cfg = loadConfig();
  const header = req.headers.authorization ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token || token !== cfg.ADMIN_TOKEN) {
    throw new AppError("admin token missing or invalid", "UNAUTHORIZED", 401);
  }
}

interface StatsRow {
  founders: number;
  conversations: number;
  turns_in: number;
  turns_out: number;
  candidates_shown: number;
  accepts: number;
  awaiting_mutual: number;
  mutual_accepts: number;
  intros_sent: number;
  declined: number;
  expired: number;
}

export async function adminRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body?: { csvPath?: string } }>("/ingest", async (req, reply) => {
    requireAdmin(req);
    // Lazy import so dev/test doesn't pull the ingest module (and its deps)
    // into the hot path.
    const { ingestCsv } = await import("../ingest/seed.js");
    const csvPath = req.body?.csvPath ?? "data/seed_founders.csv";
    const startedAt = Date.now();
    try {
      const result = await ingestCsv(csvPath);
      logger.info({ result, csvPath, ms: Date.now() - startedAt }, "admin ingest complete");
      return reply.send({ ok: true, csvPath, ...result, elapsedMs: Date.now() - startedAt });
    } catch (err) {
      logger.error({ err }, "admin ingest failed");
      throw err;
    }
  });

  app.get("/stats", async (req, reply) => {
    requireAdmin(req);
    const sql = getSql();
    const rows = await sql<Array<StatsRow>>`
      SELECT
        (SELECT count(*)::int FROM founders)                                             AS founders,
        (SELECT count(*)::int FROM conversations)                                        AS conversations,
        (SELECT count(*)::int FROM turns WHERE direction = 'in')                         AS turns_in,
        (SELECT count(*)::int FROM turns WHERE direction = 'out')                        AS turns_out,
        (SELECT count(*)::int FROM candidates_shown)                                     AS candidates_shown,
        (SELECT count(*)::int FROM candidates_shown WHERE action = 'accepted')           AS accepts,
        (SELECT count(*)::int FROM match_requests  WHERE status = 'awaiting_mutual')     AS awaiting_mutual,
        (SELECT count(*)::int FROM match_requests  WHERE status = 'mutual_accept')       AS mutual_accepts,
        (SELECT count(*)::int FROM match_requests  WHERE status = 'intro_sent')          AS intros_sent,
        (SELECT count(*)::int FROM match_requests  WHERE status = 'declined')            AS declined,
        (SELECT count(*)::int FROM match_requests  WHERE status = 'expired')             AS expired
    `;
    return reply.send({ ok: true, stats: rows[0] ?? null });
  });
}
