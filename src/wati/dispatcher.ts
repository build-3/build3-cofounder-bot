import { logger } from "../lib/logger.js";
import { findFounderByPhone, type Founder } from "../identity/gate.js";
import {
  getOrCreateConversation,
  getSearchState,
  insertInboundTurn,
  insertOutboundTurn,
  writeSearchState,
} from "../conversation/store.js";
import {
  classifyIntent,
  composeReply,
  getRecentTurns,
  type VoiceIntent,
} from "../conversation/voice.js";
import {
  formatCardText,
  getLastShownFounderId,
  getShownFounderIds,
  markShownAction,
  recordShown,
  runMatching,
} from "../matching/pipeline.js";
import { applyDelta, extractRefinement } from "../matching/refinement.js";
import { onTargetAccept, onTargetDecline, propose } from "../consent/machine.js";
import { getSql } from "../db/client.js";
import { loadConfig } from "../lib/config.js";
import type { WatiClient } from "./client.js";
import type { WatiInbound } from "./types.js";

/**
 * InboundDispatcher.
 *
 * Contract:
 *  - Exactly ONE outbound reply per inbound. The structured candidate card
 *    counts as that one reply. This combined with DB idempotency on
 *    wati_message_id is what prevents the kind of 50-message flood that
 *    triggered the kill switch.
 *  - All non-structured replies go through composeReply → LLM voice.
 *  - Intent classification uses the LLM so "actually I want technical"
 *    and "what's the weather" route correctly.
 */

export interface DispatchDeps {
  wati: WatiClient;
}

export async function dispatchInbound(msg: WatiInbound, deps: DispatchDeps): Promise<void> {
  const cfg = loadConfig();
  if (cfg.KILL_SWITCH) {
    logger.warn({ waId: msg.waId, id: msg.id }, "KILL_SWITCH active — dispatcher is a no-op");
    return;
  }

  const founder = await findFounderByPhone(msg.waId);

  if (!founder) {
    logger.info({ waId: msg.waId }, "non-cohort inbound");
    const reply = await composeReply({
      situation: "non_cohort",
      founderFirstName: "",
      recentTurns: [],
      userTurn: msg.text ?? "",
    });
    await deps.wati.sendText({ waId: msg.waId, text: reply });
    return;
  }

  if (!founder.optedIn) {
    const reply = await composeReply({
      situation: "opted_out",
      founderFirstName: firstName(founder),
      recentTurns: [],
      userTurn: msg.text ?? "",
    });
    await deps.wati.sendText({ waId: founder.phone, text: reply });
    return;
  }

  const conv = await getOrCreateConversation(founder.id);
  const sql = getSql();

  // Serialize per-conversation dispatch. WATI retries a message with a NEW
  // wati_message_id when our function is slow (observed: same WhatsApp turn
  // delivered 6x within seconds, producing duplicate candidate cards). A
  // row in `dispatch_locks` is the lease; siblings see the fresh lease and
  // no-op. Lease is auto-released in a finally block; a 30s TTL handles the
  // case where the function is killed mid-flight on Vercel.
  const lockHolder = msg.id;
  const lockAcquired = await acquireDispatchLock(sql, conv.id, lockHolder);
  if (!lockAcquired) {
    logger.info(
      { convId: conv.id, watiMessageId: msg.id },
      "sibling dispatcher holds the lock — no-op",
    );
    return;
  }

  try {
    await dispatchLocked(msg, deps, founder, conv, sql);
  } finally {
    await releaseDispatchLock(sql, conv.id, lockHolder);
  }
}

async function acquireDispatchLock(
  sql: ReturnType<typeof getSql>,
  conversationId: string,
  holder: string,
): Promise<boolean> {
  // Atomic: insert if absent, OR take over a stale lease (>30s old).
  const rows = await sql<Array<{ conversation_id: string }>>`
    INSERT INTO dispatch_locks (conversation_id, held_by, acquired_at)
    VALUES (${conversationId}, ${holder}, now())
    ON CONFLICT (conversation_id) DO UPDATE
      SET held_by = EXCLUDED.held_by,
          acquired_at = EXCLUDED.acquired_at
      WHERE dispatch_locks.acquired_at < now() - interval '30 seconds'
    RETURNING conversation_id
  `;
  return rows.length > 0;
}

async function releaseDispatchLock(
  sql: ReturnType<typeof getSql>,
  conversationId: string,
  holder: string,
): Promise<void> {
  try {
    await sql`
      DELETE FROM dispatch_locks
      WHERE conversation_id = ${conversationId} AND held_by = ${holder}
    `;
  } catch (err) {
    // Non-fatal: the 30s TTL on acquire guarantees progress even if release fails.
    logger.warn({ err, conversationId }, "dispatch lock release failed (non-fatal)");
  }
}

async function dispatchLocked(
  msg: WatiInbound,
  deps: DispatchDeps,
  founder: Founder,
  conv: { id: string; founderId: string },
  sql: ReturnType<typeof getSql>,
): Promise<void> {
  // Soft idempotency on top of the lock: if the exact same inbound text
  // landed on this conversation within the last 15s, it's a retry — no-op.
  const recentSameText = await sql<Array<{ id: string }>>`
    SELECT id FROM turns
    WHERE conversation_id = ${conv.id}
      AND direction = 'in'
      AND text = ${msg.text ?? msg.buttonPayload ?? "(interactive)"}
      AND created_at > now() - interval '15 seconds'
    LIMIT 1
  `;
  if (recentSameText.length > 0) {
    logger.info(
      { convId: conv.id, watiMessageId: msg.id },
      "duplicate inbound text within 15s — no-op",
    );
    return;
  }

  const state = await getSearchState(conv.id);
  const recent = await getRecentTurns(conv.id);
  const searchActive = Boolean(
    state.role ||
      state.sector.length ||
      state.stage.length ||
      state.location.length ||
      state.seniority ||
      state.mustHave.length,
  );

  const { intent, confidence } = await classifyIntent({
    text: msg.text,
    buttonPayload: msg.buttonPayload,
    searchActive,
    recentTurns: recent,
  });

  // Insert inbound BEFORE any side-effects so re-delivery is a no-op even if
  // the downstream LLM work throws.
  const inserted = await insertInboundTurn({
    conversationId: conv.id,
    watiMessageId: msg.id,
    text: msg.text ?? msg.buttonPayload ?? "(interactive)",
    intent,
  });
  if (!inserted) {
    logger.info({ watiMessageId: msg.id }, "duplicate WATI message — no-op");
    return;
  }

  const ctx: Ctx = {
    conv,
    founder,
    intent,
    confidence,
    deps,
    userTurn: msg.text ?? "",
    recent,
  };

  try {
    await route(ctx);
  } catch (err) {
    logger.error({ err, intent, convId: conv.id }, "dispatch failed — sending generic recovery");
    const reply = await composeReply({
      situation: "error_generic",
      founderFirstName: firstName(founder),
      recentTurns: recent,
      userTurn: msg.text ?? "",
    });
    await sendText(ctx, reply, "error");
  }
}

interface Ctx {
  conv: { id: string; founderId: string };
  founder: Founder;
  intent: VoiceIntent;
  confidence: number;
  deps: DispatchDeps;
  userTurn: string;
  recent: Array<{ direction: "in" | "out"; text: string }>;
}

async function route(ctx: Ctx): Promise<void> {
  // Low-confidence natural-language turns → ask ONE clarifying question
  // instead of guessing.
  if (ctx.confidence < 0.6 && ctx.intent === "other") {
    return onClarify(ctx);
  }

  switch (ctx.intent) {
    case "greeting":  return onGreeting(ctx);
    case "discover":  return onDiscover(ctx);
    case "refine":    return onRefine(ctx);
    case "accept":    return onAccept(ctx);
    case "skip":      return onSkip(ctx);
    case "decline":   return onDecline(ctx);
    case "stop":      return onStop(ctx);
    case "off_topic": return onOffTopic(ctx);
    case "other":
    default:          return onClarify(ctx);
  }
}

async function onGreeting(ctx: Ctx): Promise<void> {
  const text = await composeReply({
    situation: "greeting",
    founderFirstName: firstName(ctx.founder),
    recentTurns: ctx.recent,
    userTurn: ctx.userTurn,
  });
  await sendText(ctx, text, "greeting");
}

async function onDiscover(ctx: Ctx): Promise<void> {
  const state = await getSearchState(ctx.conv.id);
  const delta = await extractRefinement(state, ctx.userTurn);
  const nextState = applyDelta(state, delta);
  await writeSearchState(nextState);
  await runAndReply(ctx, nextState);
}

async function onRefine(ctx: Ctx): Promise<void> {
  const state = await getSearchState(ctx.conv.id);
  const delta = await extractRefinement(state, ctx.userTurn);
  const nextState = applyDelta(state, delta);
  await writeSearchState(nextState);
  await runAndReply(ctx, nextState);
}

async function onAccept(ctx: Ctx): Promise<void> {
  const sql = getSql();
  const pending = await sql<Array<{ id: string }>>`
    SELECT id FROM match_requests
    WHERE target_id = ${ctx.founder.id} AND status = 'awaiting_mutual'
    LIMIT 1
  `;
  if (pending[0]) {
    // Target Accept completes the handshake; onTargetAccept owns the single
    // outbound (the mutual intro to both sides).
    await onTargetAccept({ targetId: ctx.founder.id, wati: ctx.deps.wati });
    return;
  }

  const targetId = await getLastShownFounderId(ctx.conv.id);
  if (!targetId) {
    const text = await composeReply({
      situation: "nothing_to_accept",
      founderFirstName: firstName(ctx.founder),
      recentTurns: ctx.recent,
      userTurn: ctx.userTurn,
    });
    await sendText(ctx, text, "nothing-to-accept");
    return;
  }
  await markShownAction(ctx.conv.id, targetId, "accepted");

  const [shownRow] = await sql<Array<{ rationale: string }>>`
    SELECT rationale FROM candidates_shown
    WHERE conversation_id = ${ctx.conv.id} AND founder_id = ${targetId}
    ORDER BY created_at DESC LIMIT 1
  `;
  const note = shownRow?.rationale ?? "potential cofounder fit";

  try {
    await propose({
      requesterId: ctx.founder.id,
      targetId,
      requesterNote: note,
      wati: ctx.deps.wati,
    });
    const text = await composeReply({
      situation: "accept_confirm",
      founderFirstName: firstName(ctx.founder),
      recentTurns: ctx.recent,
      userTurn: ctx.userTurn,
    });
    await sendText(ctx, text, "accept");
  } catch (err) {
    logger.error({ err }, "propose failed");
    const text = await composeReply({
      situation: "error_generic",
      founderFirstName: firstName(ctx.founder),
      recentTurns: ctx.recent,
      userTurn: ctx.userTurn,
    });
    await sendText(ctx, text, "accept-failed");
  }
}

async function onSkip(ctx: Ctx): Promise<void> {
  const targetId = await getLastShownFounderId(ctx.conv.id);
  if (targetId) await markShownAction(ctx.conv.id, targetId, "skipped");
  const state = await getSearchState(ctx.conv.id);
  const sql = getSql();

  const antiSignals: string[] = [];
  if (targetId) {
    const [skipped] = await sql<Array<{ headline: string; sector_tags: string[] }>>`
      SELECT headline, sector_tags
      FROM founders
      WHERE id = ${targetId}
      LIMIT 1
    `;
    if (skipped?.headline) antiSignals.push(skipped.headline.toLowerCase());
    if (skipped?.sector_tags?.[0]) antiSignals.push(skipped.sector_tags[0].toLowerCase());
  }

  const nextState = {
    ...state,
    antiPrefs: [...state.antiPrefs, ...antiSignals].slice(-20),
  };
  await writeSearchState(nextState);
  await runAndReply(ctx, nextState);
}

async function onDecline(ctx: Ctx): Promise<void> {
  const result = await onTargetDecline({
    targetId: ctx.founder.id,
    wati: ctx.deps.wati,
    requesterConversationResolver: async (requesterId) => {
      const sql = getSql();
      const rows = await sql<Array<{ id: string }>>`
        SELECT id FROM conversations
        WHERE founder_id = ${requesterId} AND status = 'active'
        ORDER BY last_active_at DESC LIMIT 1
      `;
      return rows[0]?.id ?? null;
    },
  });
  if (result.status !== "declined") {
    const text = await composeReply({
      situation: "nothing_to_accept",
      founderFirstName: firstName(ctx.founder),
      recentTurns: ctx.recent,
      userTurn: ctx.userTurn,
    });
    await sendText(ctx, text, "decline-noop");
  }
  // When result.status === "declined", onTargetDecline has already sent the
  // soft notice to the requester. Our own reply to the decliner is implicit
  // (no message needed — they tapped a button).
}

async function onStop(ctx: Ctx): Promise<void> {
  const text = await composeReply({
    situation: "stop_ack",
    founderFirstName: firstName(ctx.founder),
    recentTurns: ctx.recent,
    userTurn: ctx.userTurn,
  });
  await sendText(ctx, text, "stop");
  // Best-effort: pause the conversation so we don't accidentally re-engage.
  const sql = getSql();
  await sql`UPDATE conversations SET status = 'paused' WHERE id = ${ctx.conv.id}`;
}

async function onOffTopic(ctx: Ctx): Promise<void> {
  const text = await composeReply({
    situation: "off_topic",
    founderFirstName: firstName(ctx.founder),
    recentTurns: ctx.recent,
    userTurn: ctx.userTurn,
  });
  await sendText(ctx, text, "off-topic");
}

async function onClarify(ctx: Ctx): Promise<void> {
  const text = await composeReply({
    situation: "clarify",
    founderFirstName: firstName(ctx.founder),
    recentTurns: ctx.recent,
    userTurn: ctx.userTurn,
  });
  await sendText(ctx, text, "clarify");
}

async function runAndReply(
  ctx: Ctx,
  state: Awaited<ReturnType<typeof getSearchState>>,
): Promise<void> {
  const shown = await getShownFounderIds(ctx.conv.id);
  const { cards } = await runMatching({
    requesterId: ctx.founder.id,
    state,
    userTurn: ctx.userTurn,
    alreadyShownFounderIds: shown,
  });

  if (cards.length === 0) {
    const text = await composeReply({
      situation: "no_matches",
      founderFirstName: firstName(ctx.founder),
      recentTurns: ctx.recent,
      userTurn: ctx.userTurn,
    });
    await sendText(ctx, text, "no-matches");
    return;
  }

  const recorded = await recordShown(ctx.conv.id, [cards[0]!]);
  if (!recorded) {
    // A concurrent dispatcher already recorded this founder. Swallow silently
    // — sending the card would duplicate. See 0002_concurrency_guards.sql.
    logger.warn(
      { convId: ctx.conv.id, founderId: cards[0]!.founder_id },
      "duplicate candidate race — dropping send",
    );
    return;
  }
  const body = formatCardText(cards[0]!);
  await ctx.deps.wati.sendButtons({
    waId: ctx.founder.phone,
    body,
    buttons: [{ text: "Accept" }, { text: "Skip" }],
  });
  await insertOutboundTurn({ conversationId: ctx.conv.id, text: body, intent: "candidate" });
}

async function sendText(ctx: Ctx, text: string, intent: string): Promise<void> {
  await ctx.deps.wati.sendText({ waId: ctx.founder.phone, text });
  await insertOutboundTurn({ conversationId: ctx.conv.id, text, intent });
}

function firstName(f: Founder): string {
  return f.name.split(" ")[0] ?? "";
}
