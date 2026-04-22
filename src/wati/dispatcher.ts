// src/wati/dispatcher.ts
import { logger } from "../lib/logger.js";
import { findFounderByPhone, fetchFounderById, normalizePhone } from "../identity/gate.js";
import {
  getOrCreateConversation,
  getSearchState,
  getRecentTurns,
  insertInboundTurn,
  insertOutboundTurn,
  writeSearchState,
} from "../conversation/store.js";
import {
  getShownFounderIds,
  markShownAction,
  recordShown,
  runMatching,
} from "../matching/pipeline.js";
import { propose } from "../consent/machine.js";
import { getSql } from "../db/client.js";
import { loadConfig } from "../lib/config.js";
import { runAgent } from "../agent/loop.js";
import type { WatiClient } from "./client.js";
import type { WatiInbound } from "./types.js";

const TESTING_WHITELIST = new Set(["917397599542", "918468090511"]);

export interface DispatchDeps {
  wati: WatiClient;
}

/**
 * Inbound dispatcher. Gate → lock → runAgent. Agent owns the conversation.
 *
 *  - Whitelist check first (silent drop for non-whitelist numbers during testing).
 *  - Single outbound guaranteed by runAgent (it calls finish_turn exactly once).
 *  - Dispatch lock prevents WATI retry duplicates.
 */
export async function dispatchInbound(msg: WatiInbound, deps: DispatchDeps): Promise<void> {
  const cfg = loadConfig();
  if (cfg.KILL_SWITCH) {
    logger.warn({ waId: msg.waId, id: msg.id }, "KILL_SWITCH active — dispatcher is a no-op");
    return;
  }

  const normalized = normalizePhone(msg.waId);
  if (!TESTING_WHITELIST.has(normalized)) {
    logger.info({ waId: msg.waId }, "non-whitelist — silent drop");
    return;
  }

  const founder = await findFounderByPhone(msg.waId);
  if (!founder) {
    logger.info({ waId: msg.waId }, "whitelist number but not in cohort DB — silent drop");
    return;
  }
  if (!founder.optedIn) {
    logger.info({ waId: msg.waId }, "opted out — silent drop");
    return;
  }

  const conv = await getOrCreateConversation(founder.id);
  const sql = getSql();

  const lockHolder = msg.id;
  const acquired = await sql<Array<{ conversation_id: string }>>`
    INSERT INTO dispatch_locks (conversation_id, held_by, acquired_at)
    VALUES (${conv.id}, ${lockHolder}, now())
    ON CONFLICT (conversation_id) DO UPDATE
      SET held_by = EXCLUDED.held_by, acquired_at = EXCLUDED.acquired_at
      WHERE dispatch_locks.acquired_at < now() - interval '30 seconds'
    RETURNING conversation_id
  `;
  if (acquired.length === 0) {
    logger.info({ convId: conv.id, watiMessageId: msg.id }, "sibling lock held — no-op");
    return;
  }

  try {
    const sameText = await sql<Array<{ id: string }>>`
      SELECT id FROM turns
      WHERE conversation_id = ${conv.id}
        AND direction = 'in'
        AND text = ${msg.text ?? msg.buttonPayload ?? "(interactive)"}
        AND created_at > now() - interval '15 seconds'
      LIMIT 1
    `;
    if (sameText.length > 0) {
      logger.info({ convId: conv.id }, "duplicate inbound text — no-op");
      return;
    }

    const inserted = await insertInboundTurn({
      conversationId: conv.id,
      watiMessageId: msg.id,
      text: msg.text ?? msg.buttonPayload ?? "(interactive)",
      intent: "agent",
    });
    if (!inserted) {
      logger.info({ watiMessageId: msg.id }, "duplicate WATI message — no-op");
      return;
    }

    await runAgent({
      founder,
      conversationId: conv.id,
      userTurn: msg.text ?? msg.buttonPayload ?? "",
      wati: deps.wati,
      deps: {
        getSearchState,
        writeSearchState,
        getRecentTurns,
        getShownFounderIds,
        runMatching,
        recordShown,
        markShownAction,
        fetchFounderDetail: fetchFounderById,
        insertOutboundTurn,
        propose: async (args) => {
          await propose({ ...args, wati: deps.wati });
        },
      },
    });
  } finally {
    await sql`DELETE FROM dispatch_locks WHERE conversation_id = ${conv.id} AND held_by = ${lockHolder}`;
  }
}
