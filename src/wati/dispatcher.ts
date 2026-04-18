import { logger } from "../lib/logger.js";
import { findFounderByPhone } from "../identity/gate.js";
import {
  getOrCreateConversation,
  insertInboundTurn,
  insertOutboundTurn,
} from "../conversation/store.js";
import { classifyIntent } from "../conversation/router.js";
import type { WatiClient } from "./client.js";
import type { WatiInbound } from "./types.js";

/**
 * InboundDispatcher. Responsibilities, in order:
 *  1. Identity gate (phone → founder). Non-cohort numbers get a polite reply.
 *  2. Upsert an active conversation.
 *  3. Idempotent insert of the inbound turn.
 *  4. Route to an intent handler.
 *
 * For Phase 2 we handle identity + help/hello + a placeholder for discover/refine/
 * accept/skip/decline. Phases 3 and 4 will wire in the matcher and consent SM.
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

  switch (intent) {
    case "help":
      await replyHello(deps, founder.name, msg.waId, conv.id);
      return;
    case "discover":
    case "refine":
      // Phase 3 will wire the matcher here. For now, ack so the UX isn't silent.
      await replyAck(deps, msg.waId, conv.id);
      return;
    case "accept":
    case "skip":
    case "decline":
      // Phase 3/4 will wire these handlers.
      await replyAck(deps, msg.waId, conv.id);
      return;
    case "other":
    default:
      await replyAck(deps, msg.waId, conv.id);
      return;
  }
}

async function replyHello(deps: DispatchDeps, name: string, waId: string, convId: string) {
  const text =
    `Hey ${name.split(" ")[0] ?? "there"} 👋 — I'm the Build3 Cofounder Bot.\n\n` +
    `Tell me in your own words what you're looking for. Examples:\n` +
    `  • "Find me a sales cofounder in fintech"\n` +
    `  • "I want a technical cofounder, B2B, seed stage"\n` +
    `  • "Growth operator in D2C, Bangalore"\n\n` +
    `You can refine as we go. Tap Accept on a match you like, Skip to see someone else.`;
  await deps.wati.sendText({ waId, text });
  await insertOutboundTurn({ conversationId: convId, text, intent: "help" });
}

async function replyAck(deps: DispatchDeps, waId: string, convId: string) {
  const text = "Got it — matching pipeline lights up in Phase 3. Hang tight.";
  await deps.wati.sendText({ waId, text });
  await insertOutboundTurn({ conversationId: convId, text, intent: "ack" });
}
