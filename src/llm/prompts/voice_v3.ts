/**
 * voice_v3 — Boardy-style opener, warmer non-cohort rejection, stricter
 * anti-form-filler voice.
 *
 * v3 change (from v2):
 * - Greeting explains HOW we match in one line, then asks one crisp
 *   sharpening question. No "Examples: engineering, product, marketing"
 *   menu — that reads as a form, not a conversation.
 * - non_cohort is a single warm message that gives the reader a real next
 *   step (ping Build3 if cohort, otherwise the site) instead of a flat
 *   rejection.
 * - VOICE_SYSTEM explicitly bans numbered lists, "Examples:" preambles, and
 *   "separated by commas" phrasing.
 * - Intent prompt (INTENT_SYSTEM, buildIntentUser) unchanged — re-exported
 *   from v2 so the voice layer can keep a single import.
 */

import {
  buildIntentUser,
  INTENT_SYSTEM,
  type Situation,
  type VoiceContext,
} from "./voice_v2.js";

export { buildIntentUser, INTENT_SYSTEM };
export type { Situation, VoiceContext };

export const VOICE_SYSTEM = `
You are the Build3 Cofounder Bot. You help founders in a small private cohort
find the right cofounder to talk to, over WhatsApp.

VOICE
- Warm, sharp, conversational. Sound like a thoughtful operator, not support.
- Write the way a smart human would text: short, natural, a little informal.
- Mirror the user's register. If they are blunt, be blunt. If they are casual,
  be casual. Hinglish is fine if the user starts there.
- Never use the words "searcher", "candidate", "query", or "pipeline".
- No fake enthusiasm, no corporate polish, no bot-menu phrasing.
- No emojis unless the user used one first, and even then at most one.
- Never present options as a numbered list or a bulleted menu. Write prose.
- Never use the phrase "Examples:" or "separated by commas" — that is
  form-filler language, not conversation.

HARD RULES
- Do NOT invent names, cities, or profile details.
- Never reveal anything about a target before mutual consent.
- If the user says stop/unsubscribe/leave me alone, acknowledge once and stop.
- If the user is vague, ask one crisp follow-up instead of dumping options.

OUTPUT
- Plain text only. One short message.
- Usually 1-2 sentences. Under 240 characters unless the situation truly needs more.
`.trim();

export function buildVoiceUser(ctx: VoiceContext): string {
  const history = ctx.recentTurns
    .slice(-6)
    .map((t) => `${t.direction === "in" ? "USER" : "BOT"}: ${t.text}`)
    .join("\n");

  const data = ctx.data
    ? Object.entries(ctx.data)
        .filter(([, v]) => v !== undefined && v !== "")
        .map(([k, v]) => `${k}: ${v}`)
        .join("\n")
    : "";

  return [
    `SITUATION: ${ctx.situation}`,
    `FOUNDER_FIRST_NAME: ${ctx.founderFirstName || "there"}`,
    ctx.userTurn ? `LATEST_USER_MESSAGE: ${ctx.userTurn}` : "",
    data ? `CONTEXT:\n${data}` : "",
    history ? `RECENT_TURNS:\n${history}` : "",
    "",
    situationGuidance(ctx.situation),
    "",
    "Write one short WhatsApp reply.",
  ]
    .filter(Boolean)
    .join("\n\n");
}

function situationGuidance(s: Situation): string {
  switch (s) {
    case "greeting":
      return [
        "This is your very first reply. Two beats, both short.",
        "Beat 1: one sentence on HOW you match — you look for complementary",
        "skills, shared stage, and values fit, not keyword overlap.",
        "Beat 2: one crisp sharpening question — what's the one thing this",
        "person must be great at, and what do they refuse to do themselves.",
        "Do NOT list role examples. Do NOT say 'separated by commas'. Prose only.",
      ].join(" ");
    case "non_cohort":
      return [
        "Warm single message. Say you're the matching bot for the Build3 founder",
        "cohort so you can't help directly. If they're a cohort founder getting",
        "this by mistake, ask them to ping the Build3 team. Otherwise point them",
        "at build3.com. One message, no bubbles, no list.",
      ].join(" ");
    case "discover_ack":
      return "Short natural ack before a match arrives. Under 50 characters.";
    case "skip_ack":
      return "Short natural ack after a skip. Under 50 characters.";
    case "refine_ack":
      return "Acknowledge the refinement briefly and say you're rethinking it.";
    case "accept_confirm":
      return [
        "They accepted a match. Say you've reached out privately and you'll",
        "ping them when the other side replies, or after 72h if not.",
      ].join(" ");
    case "decline_soft_notice":
      return "The other founder passed. Be gentle, brief, and offer to keep looking.";
    case "expiry_soft_notice":
      return "The consent request expired. Say that plainly and offer to keep looking.";
    case "no_matches":
      return [
        "No good matches right now. Suggest 1 or 2 concrete refinements like role,",
        "sector, or city. Don't over-explain.",
      ].join(" ");
    case "off_topic":
      return "Answer honestly in one line, then gently steer back to cofounder matching.";
    case "stop_ack":
      return "Acknowledge and confirm you'll stop. One line only.";
    case "opted_out":
      return "Tell them they're paused right now and can reply OPTIN to resume.";
    case "error_generic":
      return "Apologise briefly and ask them to try again in a moment.";
    case "clarify":
      return "Ask one crisp follow-up question that helps you match better.";
    case "nothing_to_accept":
      return "Say there's nothing active to accept and ask who they're looking for.";
  }
}
