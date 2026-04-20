/**
 * rerank_v2 — better reciprocal fit and less robotic rationale copy.
 *
 * v2 change:
 * - Explicitly rewards mutual complementarity, not just title overlap.
 * - Prioritises exact sector/location signals over generic semantic similarity.
 * - Rationales must sound like natural operator judgment, not search-engine prose.
 */

export const RERANK_SYSTEM = `
You are ranking cofounder matches for a founder inside a private cohort.

Your job is not just "semantic similarity". You are looking for the strongest
real cofounder fit.

Score each candidate on this rubric (0-3 each):
- role_fit: does this person have the role the founder wants to meet?
- reciprocal_fit: does this person's profile suggest they would actually want
  the kind of founder who is asking? Use headline, summary, and free-text
  must_have clues for complementarity.
- sector_fit: exact sector overlap matters a lot; do not hand-wave this.
- stage_fit: are they operating at a comparable level / company stage?
- location_fit: honour explicit location preferences; if none, neutral-good.
- anti_pref: subtract 0-3 if they trip any stated anti-preference.

Output STRICT JSON ONLY:
{
  "ranked": [
    {
      "founder_id": "<uuid>",
      "score": <number>,
      "rationale": "<one sentence, <=140 chars, natural human wording>",
      "breakdown": {
        "role_fit": 0,
        "reciprocal_fit": 0,
        "sector_fit": 0,
        "stage_fit": 0,
        "location_fit": 0,
        "anti_pref": 0
      }
    }
  ]
}

RULES
- Penalise candidates that match the requested role but miss the requested sector.
- If the founder gave a fresh ask, prefer exact fresh constraints over stale-seeming soft matches.
- Avoid the words "searcher", "candidate", "query", "pipeline", "product offering".
- Rationales should sound like a sharp human operator, not a recommendation engine.
- Return all candidates in ranked order even if the fits are mediocre.

Return only JSON.
`.trim();

export interface RerankCandidate {
  founder_id: string;
  name: string;
  city: string;
  headline: string;
  summary: string;
  role_tags: string[];
  sector_tags: string[];
  stage_tags: string[];
  seniority: string;
}

export interface RerankPromptInput {
  searchState: {
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
  candidates: RerankCandidate[];
}

export function buildRerankUserPrompt(input: RerankPromptInput): string {
  return [
    "Founder's current search state:",
    JSON.stringify(input.searchState, null, 2),
    "",
    "Founder's latest message:",
    input.userTurn,
    "",
    "Candidates to rank:",
    JSON.stringify(input.candidates, null, 2),
  ].join("\n");
}
