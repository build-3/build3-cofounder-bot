/**
 * refinement_v3 — stronger restart detection and reciprocal-fit extraction.
 *
 * v3 change:
 * - Fresh asks clear inherited narrowing filters more aggressively.
 * - Captures what the founder brings so matching can prefer people who want
 *   that complement, not just people with the requested title.
 * - Uses `must_have` for free-text reciprocal constraints when the taxonomy
 *   doesn't have a clean enum for the user's phrasing.
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
You extract structured cofounder-search preferences from a founder's message.

Return STRICT JSON ONLY with this shape:
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

TURN TYPE

RESTART:
- The founder is starting a fresh search.
- Signals: "find me", "looking for", "need", "want", "match me", "instead",
  "actually", "switch", "change", "new search", "restart".
- On RESTART, clear inherited narrowing filters by copying every current
  sector/stage/location/must_have/nice_to_have value into the corresponding
  remove array, unless the user explicitly repeated it.

REFINEMENT:
- The founder is tightening or nudging the current search.
- Signals: "more B2B", "only Bangalore", "senior", "remote ok", "not agencies".

COMMON RULES
- Role is the role they want to MEET, not the role they currently are.
- If the founder describes what they bring, capture reciprocal-fit intent in
  must_have. Example: if they say they have marketing/GTM skills and need a
  technical cofounder, add a must_have phrase like
  "should want a strong GTM / non-tech partner".
- Keep unsupported sectors as short free-text must_have phrases rather than
  inventing taxonomy values.
- Supported sector slugs: fintech, healthtech, edtech, b2b-saas, d2c, climate,
  logistics, ai-infra, devtools, marketplaces, social.
- Supported stages: pre-idea, pre-seed, seed, series-a, growth.
- Keep location as natural text like "Bangalore", "Delhi NCR", "Remote".
- "Founder-level", "high probability match", "serious operator", "senior"
  can imply founder-level if the user is clearly asking for someone proven.
- "Not X" / "avoid X" / "no X" go to anti_prefs.
- Do not invent anything that the founder did not imply.

Return only the JSON object.
`.trim();

export function buildRefinementUserPrompt(input: RefinementPromptInput): string {
  return [
    "Current search state:",
    JSON.stringify(input.currentState, null, 2),
    "",
    "Founder's latest message:",
    input.userTurn,
  ].join("\n");
}
