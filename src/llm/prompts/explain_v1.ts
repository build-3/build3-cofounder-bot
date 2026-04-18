/**
 * explain_v1 — a tiny fallback prompt used when rerank is skipped. Generates a
 * one-line rationale for a single candidate given the search state.
 *
 * Plain text output (not JSON). Callers trim + clamp to 140 chars.
 */

export const EXPLAIN_SYSTEM = `
You write a single-sentence rationale (≤140 chars) for why a candidate might fit a searcher's stated preferences.

No preamble. No markdown. No flattery. Just one sentence.
`.trim();

export interface ExplainPromptInput {
  searchState: unknown;
  candidate: {
    name: string;
    city: string;
    headline: string;
    summary: string;
    role_tags: string[];
    sector_tags: string[];
  };
}

export function buildExplainUserPrompt(input: ExplainPromptInput): string {
  return [
    `Search state: ${JSON.stringify(input.searchState)}`,
    `Candidate: ${JSON.stringify(input.candidate)}`,
  ].join("\n");
}
