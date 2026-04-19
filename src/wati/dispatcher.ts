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
  await writeSearchState({ ...state, antiPrefs: [...state.antiPrefs].slice(-20) });
  await runAndReply(ctx, state);
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

  await recordShown(ctx.conv.id, [cards[0]!]);
  const body = formatCardText(cards[0]!, 0, 1);
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
