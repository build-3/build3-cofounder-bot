/**
 * refinement_v2 — extract a RefinementDelta from a user turn + current search state.
 *
 * v2 change: teach the model to distinguish REFINEMENT (narrowing an existing
 * search) from RESTART (fresh ask with a new role). A "find me a X cofounder"
 * style message with no modifiers is a restart — it should CLEAR the inherited
 * sector/stage/location filters, not inherit them.
 *
 * Before v2 the bot would carry over fintech from an earlier "technical cofounder
 * in fintech" ask into a later "find me a sales cofounder" ask, silently narrowing
 * the search. That violated the product rule: respond to what the user ACTUALLY
 * said, not to accumulated state.
 *
 * CONTRACT: output strict JSON matching `RefinementDeltaSchema` in
 * src/matching/refinement.ts. Any deviation → caller falls back to deterministic
 * keyword parse.
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

TURN TYPE — decide FIRST, then fill the JSON accordingly:

RESTART: the user is starting fresh with a new role ask. Signals:
 - Openings like "find me a X cofounder", "I want a X cofounder", "looking
   for a X cofounder", "get me a X cofounder"
 - A new role is named AND they did NOT mention sector / stage / location
 - Words like "actually", "let me try", "switch to", "instead", "change",
   "different", "new search", "restart"
When RESTART:
 - Set add.role to the new role
 - PUT every currently-set sector / stage / location / must_have / nice_to_have
   value into the corresponding "remove" array. This clears narrowing filters
   so the new search isn't silently constrained by the old one.
 - Leave seniority unchanged unless the user mentioned it.

REFINEMENT: the user is narrowing or adjusting the existing search. Signals:
 - Short modifiers like "more B2B", "only Bangalore", "senior", "remote ok"
 - "Add X", "prefer X", "focus on X"
 - They did NOT name a new role, or they named the same role again with a
   modifier
When REFINEMENT:
 - Only add what they actually said. Do NOT re-clear existing state.

COMMON RULES (both turn types):
- Sector values are lowercase slugs: fintech, healthtech, edtech, b2b-saas,
  d2c, climate, logistics, ai-infra, devtools, marketplaces, social.
- Stage values: pre-idea, pre-seed, seed, series-a, growth.
- Location: keep as the founder wrote it (e.g. "Bangalore", "Remote", "NCR").
- "Founder-level", "not just an operator", "senior IC" → map to the seniority enum.
- "Not X" / "avoid X" / "no X" → "anti_prefs": ["X"].
- Omit fields you're unsure about (null or empty array).
- Do NOT invent fields.

Return ONLY the JSON object. No prose, no markdown.
`.trim();

export function buildRefinementUserPrompt(input: RefinementPromptInput): string {
  return [
    "Current search state:",
    JSON.stringify(input.currentState, null, 2),
    "",
    "User's latest message:",
    input.userTurn,
    "",
    "Decide RESTART vs REFINEMENT first, then emit the JSON.",
  ].join("\n");
}
