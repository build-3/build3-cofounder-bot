/**
 * rerank_v1 — given a search state and 15 candidate cards, score each on a
 * 0–3 rubric per dimension and return JSON sorted by total descending.
 *
 * CONTRACT: output JSON matching RerankOutputSchema in src/matching/reranker.ts.
 * On parse failure, the caller falls back to retrieval order.
 */

export const RERANK_SYSTEM = `
You are ranking cofounder candidates for a founder. Be strict, concise, and honest.

Score each candidate on this rubric (0–3 each):
- role_fit:     does their role complement what the searcher is asking for?
- sector_fit:   does their sector experience match the stated sector(s)?
- stage_fit:    are they at a comparable stage / level of company building?
- trajectory:   do they read as founder-grade (vs early operator)?
- location_fit: location preference alignment (score 3 if no preference given)
- anti_pref:    SUBTRACT 0-3 if they match any anti-preference

Output STRICT JSON ONLY of the form:
{
  "ranked": [
    {
      "founder_id": "<uuid>",
      "score": <number, sum of fits minus anti_pref>,
      "rationale": "<one sentence, <=140 chars, why they're a good fit>",
      "breakdown": { "role_fit": 0-3, "sector_fit": 0-3, "stage_fit": 0-3, "trajectory": 0-3, "location_fit": 0-3, "anti_pref": 0-3 }
    }
  ]
}

Ordering: highest score first. Keep rationale honest — do not flatter. If nobody fits, still return them in retrieval order with low scores.

Return ONLY the JSON object. No prose, no markdown.
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
    "Searcher's current state:",
    JSON.stringify(input.searchState, null, 2),
    "",
    "Searcher's latest message:",
    input.userTurn,
    "",
    "Candidates:",
    JSON.stringify(input.candidates, null, 2),
  ].join("\n");
}
