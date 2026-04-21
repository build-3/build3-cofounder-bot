import { z } from "zod";
import { getLLM } from "../llm/index.js";
import {
  buildIntentUser,
  buildVoiceUser,
  INTENT_SYSTEM,
  VOICE_SYSTEM,
  type Situation,
  type VoiceContext,
} from "../llm/prompts/voice_v3.js";
import { logger } from "../lib/logger.js";
import { getSql } from "../db/client.js";
import type { Sql } from "postgres";

/**
 * Voice layer. Every non-structured reply goes through `composeReply` so that
 * phrasing is LLM-generated and varied. Intent routing goes through
 * `classifyIntent` so natural-language messages like "actually I want
 * technical" or "what's the weather" route correctly.
 *
 * Both functions have deterministic fallbacks so the bot never goes silent.
 */

export type VoiceIntent =
  | "greeting"
  | "discover"
  | "refine"
  | "accept"
  | "skip"
  | "decline"
  | "stop"
  | "off_topic"
  | "topic_switch"
  | "force_intro"
  | "other";

/** Returned by classifyIntent. For "accept", `pick` is the 1-based position
 *  the user referenced when we showed two candidates (1 or 2). Absent for
 *  single-card flows; defaults to 1 at the call site. */
export interface ClassifiedIntent {
  intent: VoiceIntent;
  confidence: number;
  pick?: 1 | 2;
}

const IntentSchema = z.object({
  intent: z.enum([
    "greeting",
    "discover",
    "refine",
    "accept",
    "skip",
    "decline",
    "stop",
    "off_topic",
    "topic_switch",
    "force_intro",
    "other",
  ]),
  confidence: z.number().min(0).max(1),
});

/** Under this confidence, `topic_switch` falls back to `clarify` so a
 * hallucinated switch can't nuke an active cofounder search. */
const TOPIC_SWITCH_CONFIDENCE_FLOOR = 0.7;

export async function classifyIntent(input: {
  text?: string | undefined;
  buttonPayload?: string | undefined;
  searchActive: boolean;
  recentTurns: Array<{ direction: "in" | "out"; text: string }>;
}): Promise<ClassifiedIntent> {
  // Button payloads are authoritative — skip the LLM round-trip.
  const payload = input.buttonPayload?.toUpperCase();
  if (payload === "ACCEPT") return { intent: "accept", confidence: 1 };
  if (payload === "SKIP") return { intent: "skip", confidence: 1 };
  if (payload === "DECLINE") return { intent: "decline", confidence: 1 };
  if (payload === "FORCE_INTRO") return { intent: "force_intro", confidence: 1 };

  const text = input.text?.trim() ?? "";
  if (!text && !payload) return { intent: "other", confidence: 0 };

  // Typed equivalents of the buttons — skip the LLM.
  if (/^\s*accept\s*$/i.test(text)) return { intent: "accept", confidence: 1 };
  if (/^\s*skip\s*$/i.test(text)) return { intent: "skip", confidence: 1 };
  if (/^\s*decline\s*$/i.test(text)) return { intent: "decline", confidence: 1 };
  if (/^\s*(force\s*intro|intro anyway|reach out anyway|i'll take it)\s*$/i.test(text)) {
    return { intent: "force_intro", confidence: 0.95 };
  }

  // Numbered picks from the two-card render: "1", "2", "pick 1", "go with 2".
  // Deterministic-first per CLAUDE.md rule #6.
  const pickMatch = text.match(/^\s*(?:pick\s+|go\s+with\s+|option\s+|choose\s+)?([12])\s*$/i);
  if (pickMatch) {
    const n = Number(pickMatch[1]) as 1 | 2;
    return { intent: "accept", confidence: 0.95, pick: n };
  }

  try {
    const parsed = await getLLM().json({
      system: INTENT_SYSTEM,
      user: buildIntentUser(input),
      schemaName: "voice_intent_v2",
      temperature: 0,
      parse: (raw) => IntentSchema.parse(JSON.parse(raw)),
    });
    // Confidence gate: a low-confidence topic_switch demotes to "other" so
    // the router asks a clarifying question instead of derailing the search.
    if (parsed.intent === "topic_switch" && parsed.confidence < TOPIC_SWITCH_CONFIDENCE_FLOOR) {
      return { intent: "other", confidence: parsed.confidence };
    }
    return parsed;
  } catch (err) {
    logger.warn({ err }, "intent LLM failed — falling back to heuristic");
    return heuristicIntent(text, input.searchActive);
  }
}

function heuristicIntent(text: string, searchActive: boolean): { intent: VoiceIntent; confidence: number } {
  if (/^\s*(hi|hello|hey|start|help)\s*$/i.test(text)) return { intent: "greeting", confidence: 0.7 };
  if (/\b(next|another one|someone else|show me someone else|pass)\b/i.test(text)) {
    return { intent: "skip", confidence: 0.85 };
  }
  if (/\b(stop|unsubscribe|leave me alone|quit|don'?t message)\b/i.test(text)) return { intent: "stop", confidence: 0.8 };
  // Topic-switch heuristic: the user is asking the bot to do something
  // we don't do. Requires an explicit ask verb + an off-scope target. We
  // only fire when "cofounder" is absent, to avoid stealing a refine like
  // "find me a cofounder who's done fundraising."
  if (
    !/\b(co-?founder|partner)\b/i.test(text) &&
    /\b(find|get|connect|intro|introduce)\b.*\b(investor|investors|vc|vcs|lawyer|legal|customer|customers|cold email|fundrais|hire|recruit)/i.test(
      text,
    )
  ) {
    return { intent: "topic_switch", confidence: 0.75 };
  }
  if (/\b(find|looking for|need|want|match me|get me)\b/i.test(text)) {
    return { intent: "discover", confidence: 0.7 };
  }
  if (/\b(cofounder|co-?founder|partner|technical|sales|growth|product)\b/i.test(text)) {
    return { intent: searchActive ? "refine" : "discover", confidence: 0.65 };
  }
  return { intent: "other", confidence: 0.3 };
}

/**
 * Compose a single short reply in the bot's voice. Never returns empty.
 * Falls back to a minimal deterministic line if the LLM fails — because
 * your prompt says "never crash or go silent."
 */
export async function composeReply(ctx: VoiceContext): Promise<string> {
  try {
    const raw = await getLLM().chat(
      [
        { role: "system", content: VOICE_SYSTEM },
        { role: "user", content: buildVoiceUser(ctx) },
      ],
      { temperature: 0.85, maxTokens: 180 },
    );
    const clean = raw.trim().replace(/^["']|["']$/g, "");
    if (clean.length === 0) throw new Error("empty voice reply");
    return clean;
  } catch (err) {
    logger.warn({ err, situation: ctx.situation }, "voice LLM failed — using minimal fallback");
    return minimalFallback(ctx.situation, ctx.founderFirstName);
  }
}

function minimalFallback(s: Situation, firstName: string): string {
  const name = firstName || "there";
  switch (s) {
    case "greeting":
      return `Hey ${name} — I match cofounders on complementary skills, stage, and values fit, not just keywords. What's the one thing your cofounder has to be great at?`;
    case "discover_ack":   return "On it.";
    case "skip_ack":       return "No worries — next one coming.";
    case "refine_ack":     return "Got it — updating my search.";
    case "accept_confirm": return "Nice — I've reached out. I'll ping you the moment they reply, or in 72h if they don't.";
    case "decline_soft_notice": return "That one passed for now. Happy to keep looking — what should I tweak?";
    case "expiry_soft_notice":  return "That request timed out without a reply. Want me to find someone else?";
    case "no_matches":     return "Drawing a blank — try a role (technical/sales/growth/product) and a sector or city.";
    case "off_topic":      return "Not sure on that one — I'm here for cofounder matches though. Who are you looking for?";
    case "stop_ack":       return "Got it — I'll hold off. Just say hi whenever you want to pick this up again.";
    case "non_cohort":     return "Hey — I'm the matching bot for the Build3 founder cohort, so I can't help directly here. If you're a cohort founder getting this by mistake, ping the Build3 team. Otherwise: build3.com.";
    case "opted_out":      return "You're paused right now. Reply OPTIN to turn this back on.";
    case "error_generic":  return "Hit a snag on my side — try again in a moment.";
    case "clarify":        return "Could you say a bit more about who you're looking for?";
    case "nothing_to_accept": return "Nothing to accept yet — tell me who you're looking for first.";
    case "topic_switch":   return "I only do cofounder matching — not investors or other intros. Want me to pause your search, or keep going with a different cofounder ask?";
  }
}

/**
 * Recent turn history for a conversation, used by composeReply to stay
 * in-context. Small cap (last 6 turns) — enough for register/mirror, cheap
 * on tokens.
 */
export async function getRecentTurns(
  conversationId: string,
  limit: number = 6,
  sql: Sql = getSql(),
): Promise<Array<{ direction: "in" | "out"; text: string }>> {
  const rows = await sql<Array<{ direction: "in" | "out"; text: string }>>`
    SELECT direction, text FROM turns
    WHERE conversation_id = ${conversationId}
    ORDER BY created_at DESC
    LIMIT ${limit}
  `;
  return rows.reverse();
}
