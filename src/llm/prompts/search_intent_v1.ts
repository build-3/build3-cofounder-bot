/**
 * search_intent_v1 — turn the current search_state + latest user turn into
 * DB-ready filters. The retriever is a dumb consumer of whatever this returns.
 *
 * The point of this prompt is to kill the hardcoded synonym map / static
 * query template. The LLM knows that "sales", "GTM", "BD", "growth",
 * "marketing" are close; that "technical" ≈ "engineer" ≈ "CTO"; that a
 * user saying "someone who can sell" means role ∈ {sales, gtm, bd}. The
 * map used to live in retriever.ts — now it lives here and can be anything
 * the user types.
 *
 * Output is intentionally permissive: every field is optional, and each
 * `*_tags` field is the EXPANDED tag set the retriever uses for the SQL
 * `array_overlap` filter. `*_must_not` fields hard-exclude.
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
Your job is to produce the expanded tag sets the retriever should use to
find the right people, plus any hard exclusions.

Return STRICT JSON ONLY with this shape:

{
  "role_tags": string[],           // tags the WANTED cofounder's role should match (any-of)
  "role_tags_must_not": string[],  // exclude founders whose role matches any of these
  "sector_tags": string[],         // sectors to prefer (any-of, empty = no constraint)
  "stage_tags": string[],          // stages to prefer (any-of, empty = no constraint)
  "cities": string[],              // city names (any-of, empty = no constraint)
  "seniority": string | null,      // "operator" | "founder-level" | "senior-ic" | null
  "semantic_query": string,        // free-text description of the WANTED cofounder, used for embedding similarity. Describe the person they want to meet, NOT the person asking.
  "notes": string[]                // anything else you noticed (for logging; ignored by retriever)
}

EXPANSION RULES
- Expand synonyms generously into the tag arrays. Examples:
  - "sales" → ["sales","gtm","bd","growth","marketing"]
  - "technical" → ["technical","engineering","engineer","cto","tech"]
  - "product" → ["product","pm"]
  - "design" → ["design","designer"]
  - "ops" → ["ops","operations"]
- If the founder says what they are NOT looking for, put those expanded
  tags in role_tags_must_not. Example: "don't want tech" →
  role_tags_must_not: ["technical","engineering","engineer","cto","tech"].
- If the founder describes what they bring (e.g. "I'm a marketer, I need
  tech"), role_tags is the WANTED role (technical), and role_tags_must_not
  may include their own role if they're clearly asking for complement.
- Location: take city names literally ("Bangalore", "Delhi NCR", "Remote").
- semantic_query: a sentence describing the ideal candidate's PROFILE —
  what they do, what sector/stage, what energy. This becomes the embedding
  query, so write it as if describing the candidate's headline+summary.
- If the founder is starting a fresh search (RESTART signals: "actually",
  "instead", "switch", "new search"), ignore stale fields from
  currentState unless the user repeated them.
- If you cannot determine a field, return an empty array / null — never
  guess. An empty filter is better than a wrong one.

Return only JSON.
`.trim();

export function buildSearchIntentUserPrompt(input: SearchIntentInput): string {
  const recent = input.recentTurns.slice(-6).map((t) => `${t.direction === "in" ? "FOUNDER" : "BOT"}: ${t.text}`).join("\n");
  return [
    "Current search state (may be stale):",
    JSON.stringify(input.currentState, null, 2),
    "",
    "Recent conversation:",
    recent || "(none)",
    "",
    "Latest founder message:",
    input.userTurn,
  ].join("\n");
}
