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

import { buildIntentUser } from "./voice_v2.js";

export { buildIntentUser };

export interface VoiceContext {
  situation: Situation;
  founderFirstName: string;
  recentTurns: Array<{ direction: "in" | "out"; text: string }>;
  data?: Record<string, string | number | undefined>;
  userTurn?: string;
}

/**
 * v3 Situation union — adds `topic_switch` (user asks for a service we don't
 * offer, e.g. "find me investors"). Kept locally in v3 rather than edited
 * into v2 so the older prompt stays frozen for diff-testing.
 */
export type Situation =
  | "greeting"
  | "discover_ack"
  | "skip_ack"
  | "refine_ack"
  | "accept_confirm"
  | "decline_soft_notice"
  | "expiry_soft_notice"
  | "no_matches"
  | "off_topic"
  | "stop_ack"
  | "non_cohort"
  | "opted_out"
  | "error_generic"
  | "clarify"
  | "nothing_to_accept"
  | "topic_switch";

/**
 * v3 INTENT_SYSTEM — adds `topic_switch` to the intent enum. A topic switch
 * is specifically: the user wants a *service* we don't offer (investors,
 * legal, cold emails, fundraising help). Weather / small talk stays
 * `off_topic`. A rephrasing of the cofounder ask stays `refine` or
 * `discover`.
 */
export const INTENT_SYSTEM = `
You classify a founder's WhatsApp message into one routing intent for a
cofounder-matching bot.

Return strict JSON: { "intent": <one value below>, "confidence": <0..1> }

INTENTS
- "greeting"      : hi/hey/start/opening messages with no real ask yet
- "discover"      : a fresh search request for a cofounder
- "refine"        : adjustment of an existing cofounder search
- "accept"        : accept/introduction intent
- "skip"          : skip/next/pass intent
- "decline"       : decline/no thanks intent
- "stop"          : stop/unsubscribe/leave me alone
- "topic_switch"  : user wants a different service we do not offer
                    (investors, legal, cold-email help, fundraising advice,
                    customer intros, hiring). They are NOT looking for a
                    cofounder.
- "off_topic"     : unrelated small talk (weather, news, jokes)
- "other"         : unclear fallback

RULES
- Button payloads ACCEPT/SKIP/DECLINE are authoritative.
- Typed "next", "another one", "show me someone else", and "pass" mean "skip".
- If the user restarts with a fresh cofounder ask, label it "discover" even
  in an active conversation.
- ANY message that contains a cofounder search cue — verbs like "find",
  "looking for", "need", "want", "match me", "get me", "show me" combined
  with a role word (sales, technical, tech, engineer, product, growth,
  marketing, design, ops, GTM, BD, founder, cofounder) — is "discover" or
  "refine", NEVER "greeting". "find me a sales cofounder" is discover.
  "find me a sales founder" is discover. Greeting is ONLY bare hi/hey/yo
  with no ask attached.
- "actually find me investors" / "can you help with legal" / "find me
  customers" → topic_switch, not refine. They switched what they want the
  bot to do.
- Confidence under 0.7 on topic_switch should be treated as "clarify" by
  the caller — so only return high confidence when you're sure the user
  wants a non-cofounder service.
- Confidence under 0.6 means the bot should ask one clarifying question.
`.trim();

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
        "A greeting. Check RECENT_TURNS before you answer.",
        "IF recent turns show an active search or prior exchange: do NOT",
        "re-introduce yourself or re-explain how you match. Just warmly pick",
        "up the thread — e.g. 'hey, still on that sales cofounder search?'",
        "or 'hey — want me to keep going where we left off?'. One short line.",
        "IF there are no recent turns (genuine first message): two beats.",
        "Beat 1: one sentence on HOW you match — complementary skills, shared",
        "stage, values fit, not keyword overlap. Beat 2: one crisp sharpening",
        "question — what's the one thing this person must be great at, and",
        "what do they refuse to do themselves.",
        "Never list role examples. Never say 'separated by commas'. Prose only.",
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
    case "topic_switch":
      return [
        "The user asked for a service you don't offer (investors, legal,",
        "cold emails, etc). One honest line saying you only do cofounder",
        "matching. Then one question: do they want to pause the cofounder",
        "search, or keep going with a different cofounder ask? Do not",
        "pretend you can help with the other thing.",
      ].join(" ");
  }
}
