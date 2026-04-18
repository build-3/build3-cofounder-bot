/**
 * refinement_v1 — extract a RefinementDelta from a user turn + current search state.
 *
 * CONTRACT: output strict JSON matching `RefinementDeltaSchema` in
 * src/matching/refinement.ts. Any deviation → caller falls back to deterministic
 * keyword parse. Never crash the conversation.
 */

export interface RefinementPromptInput {
  currentState: {
    role: string | null;
    sector: string[];
    stage: string[];
    location: string[];
    seniority: string | null;
    mustHave: string[];
    niceToHave: string[];
    antiPrefs: string[];
  };
  userTurn: string;
}

export const REFINEMENT_SYSTEM = `
You extract structured cofounder-search preferences from a founder's chat message.

Return STRICT JSON ONLY, with this shape:
{
  "add": {
    "role": "technical"|"sales"|"growth"|"product"|"ops"|"design"|null,
    "sector": string[],
    "stage": string[],
    "location": string[],
    "seniority": "operator"|"founder-level"|"senior-ic"|null,
    "must_have": string[],
    "nice_to_have": string[]
  },
  "remove": {
    "sector": string[],
    "stage": string[],
    "location": string[],
    "must_have": string[],
    "nice_to_have": string[]
  },
  "anti_prefs": string[]
}

Rules:
- Omit fields you're unsure about (null or empty array).
- "Not X" / "avoid X" / "no X" → "anti_prefs": ["X"].
- Sector values are lowercase slugs: fintech, healthtech, edtech, b2b-saas, d2c, climate, logistics, ai-infra, devtools, marketplaces, social.
- Stage values: pre-idea, pre-seed, seed, series-a, growth.
- Location: keep as the founder wrote it (e.g. "Bangalore", "Remote", "NCR").
- "Founder-level", "not just an operator", "senior IC" → map to the seniority enum.
- Do NOT invent fields. If nothing is refined, return empty add/remove + empty anti_prefs.

Return ONLY the JSON object. No prose, no markdown.
`.trim();

export function buildRefinementUserPrompt(input: RefinementPromptInput): string {
  return [
    "Current search state:",
    JSON.stringify(input.currentState, null, 2),
    "",
    "User's latest message:",
    input.userTurn,
  ].join("\n");
}
