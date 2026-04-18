/**
 * Deterministic field-weight map. See docs/MATCHING.md.
 *
 * Weights are applied to the *query assembly* — they decide which fields enter
 * the embedded text and with what prominence — not directly to the final score.
 * Embedding similarity does the heavy lifting; the LLM reranker does judgment.
 */

export interface FieldWeights {
  role_tags: number;
  sector_tags: number;
  stage_tags: number;
  location: number;
  seniority: number;
  summary_semantic: number;
  skills_raw: number;
}

export const DEFAULT_WEIGHTS: FieldWeights = {
  role_tags: 0.35,
  sector_tags: 0.20,
  stage_tags: 0.15,
  location: 0.10,
  seniority: 0.10,
  summary_semantic: 0.10,
  skills_raw: 0, // intentionally zero — see ADR-004 / MATCHING.md
};

/**
 * Assemble a query string from the search state for embedding. Fields with
 * larger weights are mentioned earlier and/or repeated to give them more
 * influence over the resulting embedding.
 */
export function assembleQuery(
  state: {
    role: string | null;
    sector: string[];
    stage: string[];
    location: string[];
    seniority: string | null;
    mustHave: string[];
    niceToHave: string[];
  },
  userTurn: string,
  weights: FieldWeights = DEFAULT_WEIGHTS,
): string {
  const parts: string[] = [];

  // Role comes first and is repeated in proportion to its weight.
  if (state.role) {
    const reps = Math.max(1, Math.round(weights.role_tags * 10)); // ≈3
    parts.push(Array(reps).fill(`Looking for a ${state.role} cofounder`).join(". "));
  }

  if (state.sector.length) {
    const reps = Math.max(1, Math.round(weights.sector_tags * 10)); // ≈2
    for (let i = 0; i < reps; i++) parts.push(`Sectors: ${state.sector.join(", ")}`);
  }

  if (state.stage.length) {
    parts.push(`Stage focus: ${state.stage.join(", ")}`);
  }

  if (state.seniority) {
    parts.push(`Seniority: ${state.seniority}`);
  }

  if (state.location.length) {
    parts.push(`Location preference: ${state.location.join(", ")}`);
  }

  if (state.mustHave.length) parts.push(`Must have: ${state.mustHave.join("; ")}`);
  if (state.niceToHave.length) parts.push(`Nice to have: ${state.niceToHave.join("; ")}`);

  parts.push(`User message: ${userTurn}`);

  return parts.join("\n");
}
