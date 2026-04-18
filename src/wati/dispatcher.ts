import { logger } from "../lib/logger.js";
import { findFounderByPhone, type Founder } from "../identity/gate.js";
import {
  getOrCreateConversation,
  getSearchState,
  insertInboundTurn,
  insertOutboundTurn,
  writeSearchState,
} from "../conversation/store.js";
import { classifyIntent, type Intent } from "../conversation/router.js";
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
import type { WatiClient } from "./client.js";
import type { WatiInbound } from "./types.js";

/**
 * InboundDispatcher. Responsibilities, in order:
 *  1. Identity gate (phone → founder).
 *  2. Idempotent inbound turn insertion (short-circuit on duplicate).
 *  3. Intent dispatch:
 *     - help          → onboarding message
 *     - discover      → (re)set search state, run matcher, send top card
 *     - refine        → extract delta, merge, run matcher, send top card
 *     - accept        → Phase 4 will trigger consent SM; Phase 3 acks
 *     - skip          → mark skipped, add anti-pref, show next candidate
 *     - decline       → Phase 4 wires into SM; Phase 3 acks
 */

export interface DispatchDeps {
  wati: WatiClient;
}

export async function dispatchInbound(msg: WatiInbound, deps: DispatchDeps): Promise<void> {
  const founder = await findFounderByPhone(msg.waId);
  if (!founder) {
    logger.info({ waId: msg.waId }, "non-cohort inbound — sending polite reply");
    await deps.wati.sendText({
      waId: msg.waId,
      text:
        "Hi! This is the Build3 Cofounder Bot — it's only for founders in the Build3 cohort. " +
        "If you think you should have access, please ping the Build3 team.",
    });
    return;
  }

  if (!founder.optedIn) {
    await deps.wati.sendText({
      waId: msg.waId,
      text: "You're currently opted out of the cofounder bot. Reply OPTIN to turn it back on.",
    });
    return;
  }

  const conv = await getOrCreateConversation(founder.id);
  const intent = classifyIntent({ text: msg.text, buttonPayload: msg.buttonPayload });

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

  const ctx = { conv, founder, intent, deps, userTurn: msg.text ?? "" };
  switch (intent) {
    case "help":
      return onHello(ctx);
    case "discover":
      return onDiscover(ctx);
    case "refine":
      return onRefine(ctx);
    case "accept":
      return onAccept(ctx);
    case "skip":
      return onSkip(ctx);
    case "decline":
      return onDecline(ctx);
    case "other":
    default:
      return onRefine(ctx); // treat stray messages as refinement turns
  }
}

interface Ctx {
  conv: { id: string; founderId: string };
  founder: Founder;
  intent: Intent;
  deps: DispatchDeps;
  userTurn: string;
}

async function onHello(ctx: Ctx) {
  const text =
    `Hey ${ctx.founder.name.split(" ")[0] ?? "there"} 👋 — I'm the Build3 Cofounder Bot.\n\n` +
    `Tell me in your own words what you're looking for. Examples:\n` +
    `  • "Find me a sales cofounder in fintech"\n` +
    `  • "I want a technical cofounder, B2B, seed stage"\n` +
    `  • "Growth operator in D2C, Bangalore"\n\n` +
    `Refine naturally as we go. Tap *Accept* to connect, *Skip* to see someone else.`;
  await send(ctx, text, "help");
}

async function onDiscover(ctx: Ctx) {
  await send(ctx, "Looking for good matches — one sec ⏳", "ack");
  const state = await getSearchState(ctx.conv.id);
  // A discover turn may also carry refinement (e.g. "find me a sales cofounder in fintech")
  const delta = await extractRefinement(state, ctx.userTurn);
  const nextState = applyDelta(state, delta);
  await writeSearchState(nextState);
  await runAndReply(ctx, nextState);
}

async function onRefine(ctx: Ctx) {
  const state = await getSearchState(ctx.conv.id);
  const delta = await extractRefinement(state, ctx.userTurn);
  const nextState = applyDelta(state, delta);
  await writeSearchState(nextState);
  await runAndReply(ctx, nextState);
}

async function onAccept(ctx: Ctx) {
  // If this founder is the TARGET of an awaiting_mutual request, their Accept
  // completes the handshake. Otherwise, they're the REQUESTER accepting a card.
  const sql = getSql();
  const pending = await sql<Array<{ id: string }>>`
    SELECT id FROM match_requests
    WHERE target_id = ${ctx.founder.id} AND status = 'awaiting_mutual'
    LIMIT 1
  `;
  if (pending[0]) {
    await onTargetAccept({ targetId: ctx.founder.id, wati: ctx.deps.wati });
    // onTargetAccept sends the intro to both sides — no extra reply needed.
    return;
  }

  const targetId = await getLastShownFounderId(ctx.conv.id);
  if (!targetId) {
    await send(ctx, "Nothing to accept yet — tell me who you're looking for first.", "ack");
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
    await send(
      ctx,
      "Nice — I've reached out to them. I'll ping you the moment they reply " +
        "(or in 72h if they don't).",
      "accept",
    );
  } catch (err) {
    logger.error({ err }, "propose failed");
    await send(
      ctx,
      "Hit a snag reaching out to them. I've logged it and will retry. " +
        "Meanwhile — reply with what to refine or say \"next\".",
      "accept-failed",
    );
  }
}

async function onSkip(ctx: Ctx) {
  const targetId = await getLastShownFounderId(ctx.conv.id);
  if (targetId) await markShownAction(ctx.conv.id, targetId, "skipped");

  // Weak negative signal: append targeted anti-pref tokens if any stand out.
  const state = await getSearchState(ctx.conv.id);
  await writeSearchState({ ...state, antiPrefs: [...state.antiPrefs].slice(-20) }); // cap to last 20
  await runAndReply(ctx, state, { ackFirst: "Got it — let me find someone else." });
}

async function onDecline(ctx: Ctx) {
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
  if (result.status === "declined") {
    await send(ctx, "Thanks — no problem. We won't share anything further about you.", "decline");
  } else {
    await send(ctx, "Nothing pending for you to decline right now.", "decline");
  }
}

async function runAndReply(
  ctx: Ctx,
  state: Awaited<ReturnType<typeof getSearchState>>,
  opts: { ackFirst?: string } = {},
) {
  if (opts.ackFirst) await send(ctx, opts.ackFirst, "ack");

  const shown = await getShownFounderIds(ctx.conv.id);
  const { cards } = await runMatching({
    requesterId: ctx.founder.id,
    state,
    userTurn: ctx.userTurn,
    alreadyShownFounderIds: shown,
  });

  if (cards.length === 0) {
    await send(
      ctx,
      "Drawing a blank on that one — try giving me a role (technical/sales/growth/product) " +
        "and a sector or location to narrow things down.",
      "no-matches",
    );
    return;
  }

  await recordShown(ctx.conv.id, [cards[0]!]); // show one at a time; 2–3 held for skips
  const text = formatCardText(cards[0]!, 0, 1);
  await ctx.deps.wati.sendButtons({
    waId: ctx.founder.phone,
    body: text,
    buttons: [{ text: "Accept" }, { text: "Skip" }],
  });
  await insertOutboundTurn({ conversationId: ctx.conv.id, text, intent: "candidate" });
}

async function send(ctx: Ctx, text: string, intent: string) {
  await ctx.deps.wati.sendText({ waId: ctx.founder.phone, text });
  await insertOutboundTurn({ conversationId: ctx.conv.id, text, intent });
}
