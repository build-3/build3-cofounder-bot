/**
 * voice_v2 — tighter, more natural WhatsApp voice.
 *
 * v2 change:
 * - Less bot-like greeting and fewer canned examples.
 * - Stronger steer away from formal "searcher/candidate" language.
 * - Better off-topic / clarify behavior so the bot feels more like a person
 *   and less like a menu wrapped around a matcher.
 */

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

HARD RULES
- Do NOT invent names, cities, or profile details.
- Never reveal anything about a target before mutual consent.
- If the user says stop/unsubscribe/leave me alone, acknowledge once and stop.
- If the user is vague, ask one crisp follow-up instead of dumping options.

OUTPUT
- Plain text only. One short message.
- Usually 1-2 sentences. Under 220 characters unless the situation truly needs more.
`.trim();

export interface VoiceContext {
  situation: Situation;
  founderFirstName: string;
  recentTurns: Array<{ direction: "in" | "out"; text: string }>;
  data?: Record<string, string | number | undefined>;
  userTurn?: string;
}

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
  | "nothing_to_accept";

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
        "First hello. Introduce yourself briefly, then ask who they're looking",
        "to meet in their own words. Give 2 short examples max, and make them",
        "sound natural, not like canned demo prompts.",
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
    case "non_cohort":
      return "Say this bot is only for the Build3 cohort and point them to the team.";
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

export const INTENT_SYSTEM = `
You classify a founder's WhatsApp message into one routing intent for a
cofounder-matching bot.

Return strict JSON: { "intent": <one value below>, "confidence": <0..1> }

INTENTS
- "greeting"      : hi/hey/start/opening messages with no real ask yet
- "discover"      : a fresh search request
- "refine"        : adjustment of an existing search
- "accept"        : accept/introduction intent
- "skip"          : skip/next/pass intent
- "decline"       : decline/no thanks intent
- "stop"          : stop/unsubscribe/leave me alone
- "off_topic"     : unrelated to cofounder matching
- "other"         : unclear fallback

RULES
- Button payloads ACCEPT/SKIP/DECLINE are authoritative.
- Typed "next", "another one", "show me someone else", and "pass" mean "skip".
- If the user restarts with a fresh ask, label it "discover" even in an active conversation.
- Confidence under 0.6 means the bot should ask one clarifying question.
`.trim();

export function buildIntentUser(input: {
  text?: string | undefined;
  buttonPayload?: string | undefined;
  searchActive: boolean;
  recentTurns: Array<{ direction: "in" | "out"; text: string }>;
}): string {
  const history = input.recentTurns
    .slice(-4)
    .map((t) => `${t.direction === "in" ? "USER" : "BOT"}: ${t.text}`)
    .join("\n");

  return [
    input.buttonPayload ? `BUTTON_PAYLOAD: ${input.buttonPayload}` : "",
    input.text ? `TEXT: ${input.text}` : "",
    `SEARCH_ACTIVE: ${input.searchActive}`,
    history ? `RECENT_TURNS:\n${history}` : "",
    "",
    "Return JSON only.",
  ]
    .filter(Boolean)
    .join("\n");
}
