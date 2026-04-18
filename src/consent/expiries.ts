import type { Sql } from "postgres";
import { getSql } from "../db/client.js";
import { logger } from "../lib/logger.js";
import type { WatiClient } from "../wati/client.js";

/**
 * Expires any awaiting_mutual row whose expires_at is past. Sends a soft nudge
 * to the requester; the target is NOT contacted (they didn't engage — respect that).
 *
 * Called periodically from the server boot (setInterval) in MVP. No separate worker.
 */
export async function runExpiryTick(wati: WatiClient, sql: Sql = getSql()): Promise<number> {
  const expiring = await sql<Array<{ id: string; requester_id: string }>>`
    UPDATE match_requests
       SET status = 'expired', updated_at = now()
     WHERE status = 'awaiting_mutual' AND expires_at < now()
     RETURNING id, requester_id
  `;
  if (expiring.length === 0) return 0;

  for (const row of expiring) {
    try {
      const [requester] = await sql<Array<{ phone: string }>>`
        SELECT phone FROM founders WHERE id = ${row.requester_id} LIMIT 1
      `;
      if (!requester) continue;
      await wati.sendText({
        waId: requester.phone,
        text:
          "Didn't hear back from that founder — happy to keep looking. " +
          "Tell me what to refine or say \"next\".",
      });
      await sql`INSERT INTO events (type, payload) VALUES ('consent.expired', ${sql.json({ matchRequestId: row.id })})`;
    } catch (err) {
      logger.warn({ err, matchRequestId: row.id }, "failed to notify requester of expiry");
    }
  }
  logger.info({ expired: expiring.length }, "consent expiries processed");
  return expiring.length;
}

const FIFTEEN_MIN = 15 * 60 * 1000;
let timer: NodeJS.Timeout | null = null;

export function startExpiryJob(wati: WatiClient, intervalMs: number = FIFTEEN_MIN): () => void {
  stopExpiryJob();
  timer = setInterval(() => {
    runExpiryTick(wati).catch((err) => logger.error({ err }, "expiry tick failed"));
  }, intervalMs);
  if (typeof timer.unref === "function") timer.unref();
  return stopExpiryJob;
}

export function stopExpiryJob(): void {
  if (timer) { clearInterval(timer); timer = null; }
}
