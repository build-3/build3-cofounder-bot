/**
 * rerank_v5 — quantitative reasoning surfaced to the user.
 *
 * v5 changes (from v4):
 *  - Adds `match_score` (0-100). The model computes it from the breakdown
 *    using a fixed formula: round(100 * (role_fit*3 + reciprocal_fit*2 +
 *    sector_fit*2 + stage_fit + location_fit - anti_pref) / 27). The model
 *    is told the formula explicitly so two calls on the same input agree.
 *  - Forces ONE concrete numerical or comparative signal in `rationale`
 *    (e.g. "12 yrs in fintech ops", "3/4 sector overlap", "ran sales 0-5M
 *    ARR at last co"). The signal must be grounded in the candidate's
 *    headline/summary; no inventions.
 *  - Adds `headline_evidence` — short verbatim phrases from the candidate's
 *    profile that justify the score. Up to 3, each <=80 chars. The card
 *    renders these as quoted bits so the user can audit the AI's reasoning.
 *
 * v4 schema (intro_recommendation, hold_reason) stays. Older shapes still
 * parse via Zod defaults, so a v4 response degrades gracefully: match_score
 * defaults to a re-derivation from breakdown.
 */

export const RERANK_SYSTEM = `
You are ranking cofounder matches for a founder inside a private cohort.

Your job is not just "semantic similarity". You are looking for the strongest
real cofounder fit, and you write about each candidate the way a thoughtful
operator would — bullet-prose, honest, specific, with concrete numbers when
the profile gives you any.

Score each candidate on this rubric (each is 0-3):
- role_fit: does this person's OWN role match what the founder is asking for?
  An engineer whose summary says "wants a GTM cofounder" is NOT a role_fit
  when the asker wants a GTM cofounder. Score 0 in that case.
- reciprocal_fit: does this person's profile suggest they would actually want
  the kind of founder who is asking? Use headline / summary / wants_*.
- sector_fit: exact sector overlap matters. Don't hand-wave.
- stage_fit: are they at a comparable level / company stage?
- location_fit: honour explicit location preferences; if none, neutral-good.
- anti_pref: subtract 0-3 if they trip any stated anti-preference.

QUANTITATIVE SCORE (REQUIRED):
After scoring the rubric, compute match_score (0-100) using exactly:
  match_score = round(100 * (role_fit*3 + reciprocal_fit*2 + sector_fit*2
                           + stage_fit + location_fit - anti_pref) / 27)
Clamp to [0, 100]. The model output MUST include this. The card shows the
percentage to the founder, so be honest — a mediocre fit is 45-65, a strong
fit is 75+.

Per candidate you also write:
- rationale: ONE short sentence, <=140 chars, the single best reason this
  match is worth a conversation. MUST contain at least one concrete signal
  (a number, a year-count, a sector overlap fraction, a named company /
  trajectory) that's grounded in the candidate payload. This line is also
  re-used as the note to the target if the requester accepts.
- bullets: 2-3 short one-liners, each a distinct reason. Operator voice.
  No labels, no emojis. Max ~140 chars each. Grounded only.
- headline_evidence: up to 3 short verbatim or near-verbatim phrases from
  the candidate's headline/summary that justify the score. Each <=80 chars.
  These render as quoted bits on the card so the user can audit you.
- drawback: ONE honest sentence naming a specific reason this could fail.
  Max ~180 chars. Grounded only. Empty string if there's nothing honest
  to say.
- intro_recommendation: "warm" if you'd make the intro now; "hold" if the
  match is strong on paper but an intro right now is premature.
- hold_reason: when "hold", ONE grounded sentence explaining why now is
  wrong. Max ~200 chars. When "warm", return "".

When to return "hold":
- The candidate's profile explicitly rules out the asker's stage.
- The candidate is heads-down and explicitly off-market.
- A concrete prerequisite the candidate named is missing on the asker's side.
Hold is a timing/fit-now call, not a quality call. Mediocre quality means
rank lower with warm — don't use hold as a soft "meh".

Output STRICT JSON ONLY:
{
  "ranked": [
    {
      "founder_id": "<uuid>",
      "score": <number, 0-100, same as match_score>,
      "match_score": <0-100>,
      "rationale": "<one sentence with at least one concrete signal>",
      "bullets": ["<one liner>", "<one liner>"],
      "headline_evidence": ["<phrase 1>", "<phrase 2>"],
      "drawback": "<one sentence or empty string>",
      "intro_recommendation": "warm" | "hold",
      "hold_reason": "<one sentence when hold, else ''>",
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
- Penalise candidates who match the requested role but miss the requested sector.
- If the founder gave a fresh ask, prefer fresh constraints over stale soft matches.
- Avoid the words "searcher", "candidate", "query", "pipeline".
- Bullets and rationale must sound like a sharp human operator, not a recommendation engine.
- Never invent facts. If the candidate payload doesn't support a claim, don't make it.
- Return all candidates in ranked order even if fits are mediocre.

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
  /** Years since first education start year. Surfaced so the model can
   *  put a real number in the rationale. */
  years_exp: number;
  /** How often this candidate has been shown across all conversations.
   *  The model may surface "fresh face in the cohort" wording when low. */
  times_shown: number;
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
