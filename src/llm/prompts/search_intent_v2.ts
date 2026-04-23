/**
 * search_intent_v2 — explicit-only filters.
 *
 * v2 change (from v1):
 * - sector_tags, stage_tags, cities are ONLY populated when the user
 *   explicitly mentioned them in their current message or recent turns.
 *   Stale currentState values are ignored for these fields so a simple
 *   "find me a sales founder" doesn't silently inherit a sector/stage
 *   filter the user never asked for in this conversation.
 * - role_tags expansion logic is unchanged.
 * - semantic_query now describes only what the user actually asked for —
 *   no padding with inferred sector/stage.
 */

export interface SearchIntentInput {
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
  recentTurns: Array<{ direction: "in" | "out"; text: string }>;
}

export const SEARCH_INTENT_SYSTEM = `
You translate a founder's cofounder-search request into concrete database
filters. The DB stores each founder's OWN role/sector/stage as string tags.

Return STRICT JSON ONLY with this shape:

{
  "role_tags": string[],           // tags the WANTED cofounder's role should match (any-of)
  "role_tags_must_not": string[],  // exclude founders whose role matches any of these
  "sector_tags": string[],         // ONLY if user explicitly named a sector — else []
  "stage_tags": string[],          // ONLY if user explicitly named a stage — else []
  "cities": string[],              // ONLY if user explicitly named a location — else []
  "seniority": string | null,      // "operator" | "founder-level" | "senior-ic" | null
  "semantic_query": string,        // free-text description of the WANTED cofounder for embedding
  "notes": string[]                // anything else noticed (for logging; ignored by retriever)
}

ROLE EXPANSION RULES
Expand synonyms generously into role_tags. Examples:
- "sales" → ["sales","gtm","bd","growth","marketing"]
- "technical" → ["technical","engineering","engineer","cto","tech"]
- "product" → ["product","pm"]
- "design" → ["design","designer"]
- "ops" → ["ops","operations"]

If the founder says what they are NOT looking for, put those expanded
tags in role_tags_must_not.

CRITICAL — EXPLICIT-ONLY RULE FOR SECTOR / STAGE / LOCATION
- sector_tags: return [] UNLESS the user explicitly said a sector in their
  message or the last 3 turns (e.g. "fintech", "healthtech", "B2B SaaS").
  Do NOT infer sector from currentState.sector.
- stage_tags: return [] UNLESS the user explicitly said a stage in their
  message or the last 3 turns (e.g. "pre-seed", "seed", "Series A").
  Do NOT infer stage from currentState.stage.
- cities: return [] UNLESS the user explicitly named a city or location in
  their message or the last 3 turns.
  Do NOT infer location from currentState.location.

The goal: "find me a sales founder" should produce role_tags for sales and
nothing else. Let the embedding carry the rest. Only add structured filters
when the user asked for them.

ANTI-PREFS
If the user said "not X" / "avoid X" / "no X", note it in role_tags_must_not
if it's a role, or in notes if it's something else (sector, trait, etc.).

SEMANTIC QUERY
Write a short sentence describing the ideal candidate's profile based on
what the user actually asked for — not padded with inferred attributes.
Example: user said "sales founder" → "experienced sales or GTM founder
who can own revenue and customer development."

Return only JSON.
`.trim();

export function buildSearchIntentUserPrompt(input: SearchIntentInput): string {
  const recent = input.recentTurns
    .slice(-6)
    .map((t) => `${t.direction === "in" ? "FOUNDER" : "BOT"}: ${t.text}`)
    .join("\n");
  return [
    "Current search state (do NOT use sector/stage/location from here unless user repeated them):",
    JSON.stringify(input.currentState, null, 2),
    "",
    "Recent conversation:",
    recent || "(none)",
    "",
    "Latest founder message:",
    input.userTurn,
  ].join("\n");
}
