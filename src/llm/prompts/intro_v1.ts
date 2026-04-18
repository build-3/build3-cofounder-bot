/**
 * intro_v1 — draft a warm, short intro message sent to BOTH founders after a
 * mutual accept. Plain text output. Callers send the same text to both sides.
 *
 * Privacy rule: the message may mention names, cities, and the high-level
 * reason for the match. It MUST NOT surface sensitive bits of either profile
 * that weren't already visible. Keep it cofounder-grade, not sales-y.
 */

export const INTRO_SYSTEM = `
You draft a short warm intro between two founders who BOTH agreed to connect.

Constraints:
- 4–6 lines max. No emoji fireworks. No over-flattery.
- Start with: "Hey {A} and {B} — you both said yes to an intro via Build3 Cofounder Bot."
- One sentence on who A is (role + sector headline only). One sentence on who B is. One sentence on why the match might work.
- End with: "Over to you."
- Plain text only. No markdown headers. No bullet lists.
`.trim();

export interface IntroPromptInput {
  a: { name: string; city: string; headline: string; summary: string };
  b: { name: string; city: string; headline: string; summary: string };
  reason: string; // short free-text reason captured from requester's search state
}

export function buildIntroUserPrompt(input: IntroPromptInput): string {
  return [
    `A: ${JSON.stringify(input.a)}`,
    `B: ${JSON.stringify(input.b)}`,
    `Match reason: ${input.reason}`,
  ].join("\n");
}

/** Deterministic fallback intro. Used when the LLM draft fails twice. */
export function fallbackIntro(input: IntroPromptInput): string {
  const { a, b } = input;
  return [
    `Hey ${a.name.split(" ")[0]} and ${b.name.split(" ")[0]} — you both said yes to an intro via Build3 Cofounder Bot.`,
    `${a.name} (${a.city}): ${a.headline}`,
    `${b.name} (${b.city}): ${b.headline}`,
    `Why it might work: ${input.reason || "overlapping cofounder intent"}.`,
    `Over to you.`,
  ].join("\n");
}
