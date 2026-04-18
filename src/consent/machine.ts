import type { Sql, TransactionSql } from "postgres";
import { getSql } from "../db/client.js";

type SqlLike = Sql | TransactionSql;
import { loadConfig } from "../lib/config.js";
import { AppError } from "../lib/errors.js";
import { getLLM } from "../llm/index.js";
import { buildIntroUserPrompt, fallbackIntro, INTRO_SYSTEM } from "../llm/prompts/intro_v1.js";
import { logger } from "../lib/logger.js";
import type { WatiClient } from "../wati/client.js";
import { insertOutboundTurn } from "../conversation/store.js";

/**
 * Consent state machine. THE ONLY writer of `match_requests.status`. See
 * `docs/STATE_MACHINE.md` for invariants.
 *
 * Privacy rule: the target sees only {requester name, city, 1-line rationale}.
 * Nothing more about the requester is revealed until `mutual_accept`.
 */

export type ConsentStatus =
  | "proposed"
  | "awaiting_mutual"
  | "mutual_accept"
  | "declined"
  | "expired"
  | "intro_sent"
  | "failed_delivery";

interface MinimalFounder {
  id: string;
  name: string;
  city: string;
  phone: string;
  headline: string;
  summary: string;
}

async function loadFounder(id: string, sql: SqlLike): Promise<MinimalFounder> {
  const rows = await sql<Array<MinimalFounder>>`
    SELECT id, name, city, phone, headline, summary FROM founders WHERE id = ${id} LIMIT 1
  `;
  const f = rows[0];
  if (!f) throw new AppError("founder not found", "NOT_FOUND", 404, { id });
  return f;
}

async function logEvent(type: string, payload: Record<string, unknown>, sql: SqlLike) {
  // postgres.js JSONValue typing is strict; cast payload at the boundary.
  await sql`INSERT INTO events (type, payload) VALUES (${type}, ${sql.json(payload as never)})`;
}

/**
 * Called when the requester taps Accept on a shown candidate. Creates a
 * match_request in `proposed`, sends the consent prompt to the target, and
 * transitions to `awaiting_mutual`.
 *
 * Returns the match_request id.
 */
export async function propose(args: {
  requesterId: string;
  targetId: string;
  requesterNote: string; // 1-line "why" captured from the candidate rationale
  wati: WatiClient;
  sql?: Sql;
}): Promise<{ matchRequestId: string; status: ConsentStatus }> {
  const sql = args.sql ?? getSql();
  const cfg = loadConfig();

  if (args.requesterId === args.targetId) {
    throw new AppError("cannot propose intro to self", "VALIDATION", 400);
  }

  return await sql.begin(async (tx) => {
    // Block concurrent active request for same pair in either direction.
    const active = await tx<Array<{ id: string }>>`
      SELECT id FROM match_requests
      WHERE ((requester_id = ${args.requesterId} AND target_id = ${args.targetId})
          OR (requester_id = ${args.targetId}    AND target_id = ${args.requesterId}))
        AND status IN ('proposed','awaiting_mutual','mutual_accept')
      LIMIT 1
    `;
    if (active[0]) {
      throw new AppError("active match request already exists for this pair", "CONFLICT", 409, {
        matchRequestId: active[0].id,
      });
    }

    const expiresAt = new Date(Date.now() + cfg.CONSENT_EXPIRY_HOURS * 3600 * 1000);
    const inserted = await tx<Array<{ id: string }>>`
      INSERT INTO match_requests (requester_id, target_id, status, requester_note, expires_at)
      VALUES (${args.requesterId}, ${args.targetId}, 'proposed', ${args.requesterNote}, ${expiresAt})
      RETURNING id
    `;
    const matchRequestId = inserted[0]!.id;

    const [requester, target] = await Promise.all([
      loadFounder(args.requesterId, tx),
      loadFounder(args.targetId, tx),
    ]);

    const body =
      `${requester.name} (${requester.city}) wants to connect on Build3 Cofounder Bot.\n\n` +
      `Why: ${args.requesterNote}\n\n` +
      `Tap *Accept* to let us intro you, or *Decline* to pass. ` +
      `(We won't share any more about you unless you accept.)`;

    try {
      await args.wati.sendButtons({
        waId: target.phone,
        body,
        buttons: [{ text: "Accept" }, { text: "Decline" }],
      });
    } catch (err) {
      logger.error({ err, matchRequestId }, "failed to send consent request to target");
      await tx`
        UPDATE match_requests SET status = 'failed_delivery', updated_at = now()
        WHERE id = ${matchRequestId}
      `;
      await logEvent("consent.failed_delivery", { matchRequestId }, tx);
      throw err;
    }

    await tx`
      UPDATE match_requests SET status = 'awaiting_mutual', updated_at = now()
      WHERE id = ${matchRequestId}
    `;
    await logEvent("consent.awaiting_mutual", { matchRequestId, requesterId: args.requesterId, targetId: args.targetId }, tx);

    return { matchRequestId, status: "awaiting_mutual" as const };
  });
}

/**
 * Called when the TARGET taps Accept. Looks up the awaiting_mutual row whose
 * target is this founder. If found → mutual_accept → draft intro → send to
 * both → intro_sent.
 */
export async function onTargetAccept(args: {
  targetId: string;
  wati: WatiClient;
  sql?: Sql;
}): Promise<{ matchRequestId: string | null; status: ConsentStatus | "none" }> {
  const sql = args.sql ?? getSql();

  // Most recent awaiting_mutual request targeting this founder.
  const row = await sql<Array<{ id: string; requester_id: string; requester_note: string }>>`
    SELECT id, requester_id, requester_note FROM match_requests
    WHERE target_id = ${args.targetId} AND status = 'awaiting_mutual'
    ORDER BY created_at DESC LIMIT 1
  `;
  if (!row[0]) return { matchRequestId: null, status: "none" };

  const matchRequestId = row[0].id;
  const requesterId = row[0].requester_id;
  const reason = row[0].requester_note;

  await sql`
    UPDATE match_requests SET status = 'mutual_accept', updated_at = now()
    WHERE id = ${matchRequestId}
  `;
  await logEvent("consent.mutual_accept", { matchRequestId }, sql);

  const [a, b] = await Promise.all([
    loadFounder(requesterId, sql),
    loadFounder(args.targetId, sql),
  ]);

  let introText: string;
  try {
    introText = await getLLM().chat([
      { role: "system", content: INTRO_SYSTEM },
      { role: "user", content: buildIntroUserPrompt({ a, b, reason }) },
    ], { temperature: 0.4, maxTokens: 240 });
    if (!introText || introText.trim().length < 20) {
      throw new Error("intro draft too short");
    }
  } catch (err) {
    logger.warn({ err, matchRequestId }, "intro draft failed — using fallback");
    introText = fallbackIntro({ a, b, reason });
  }

  // Send to both sides.
  try {
    await args.wati.sendText({ waId: a.phone, text: introText });
    await args.wati.sendText({ waId: b.phone, text: introText });
  } catch (err) {
    logger.error({ err, matchRequestId }, "intro delivery failed");
    await sql`
      UPDATE match_requests SET status = 'failed_delivery', updated_at = now()
      WHERE id = ${matchRequestId}
    `;
    throw err;
  }

  await sql.begin(async (tx) => {
    await tx`INSERT INTO intros (match_request_id, intro_text) VALUES (${matchRequestId}, ${introText})`;
    await tx`UPDATE match_requests SET status = 'intro_sent', updated_at = now() WHERE id = ${matchRequestId}`;
    await logEvent("consent.intro_sent", { matchRequestId }, tx);
  });

  return { matchRequestId, status: "intro_sent" };
}

/**
 * Called when the TARGET taps Decline. Updates the awaiting_mutual row and
 * sends a soft notice to the requester (no target identity beyond what the
 * requester already saw).
 */
export async function onTargetDecline(args: {
  targetId: string;
  wati: WatiClient;
  requesterConversationResolver: (requesterId: string) => Promise<string | null>;
  sql?: Sql;
}): Promise<{ matchRequestId: string | null; status: ConsentStatus | "none" }> {
  const sql = args.sql ?? getSql();

  const row = await sql<Array<{ id: string; requester_id: string }>>`
    SELECT id, requester_id FROM match_requests
    WHERE target_id = ${args.targetId} AND status = 'awaiting_mutual'
    ORDER BY created_at DESC LIMIT 1
  `;
  if (!row[0]) return { matchRequestId: null, status: "none" };

  const matchRequestId = row[0].id;
  const requesterId = row[0].requester_id;

  await sql`
    UPDATE match_requests SET status = 'declined', updated_at = now() WHERE id = ${matchRequestId}
  `;
  await logEvent("consent.declined", { matchRequestId }, sql);

  const requester = await loadFounder(requesterId, sql);
  const softNotice =
    `Heads up — that founder passed on this one. Happy to keep looking. ` +
    `Reply with what to refine (role/sector/location/etc.) or say "next".`;
  try {
    await args.wati.sendText({ waId: requester.phone, text: softNotice });
    const convId = await args.requesterConversationResolver(requesterId);
    if (convId) await insertOutboundTurn({ conversationId: convId, text: softNotice, intent: "decline-notice" });
  } catch (err) {
    logger.warn({ err, matchRequestId }, "failed to notify requester of decline");
  }

  return { matchRequestId, status: "declined" };
}
