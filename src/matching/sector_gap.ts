/**
 * Detect when the top-ranked card is an honest miss on the sector the user
 * asked for. The cohort is finite (~1k founders) so a "find me a defence-tech
 * cofounder" query can legitimately return zero defence founders. When that
 * happens we must say so — serving a b2b-saas founder as if they fit is
 * dishonest and erodes trust.
 *
 * This is deterministic on purpose: sector-gap detection cannot depend on the
 * LLM being in a good mood.
 */

import type { SearchStateRow } from "../conversation/store.js";

export interface SectorGapResult {
  /** True when the asked domain isn't represented in the top card. */
  gap: boolean;
  /** Human-readable phrase for the domain the user asked about, e.g. "defence
   * tech". Empty string when we couldn't confidently pin down a domain — in
   * that case `gap` is always false. */
  askedDomain: string;
}

interface CardLike {
  headline: string;
  sector_tags: string[];
  bullets?: string[];
  rationale?: string;
}

/**
 * Extract the domain phrase the user is asking about. We look at three sources
 * in order of trust:
 *   1. Explicit state.sector entries (already normalised taxonomy tags)
 *   2. Free-text "in X tech" / "in X" / "X-tech" from the user turn
 *   3. must_have entries that look like sector free-text
 */
export function extractAskedDomain(state: SearchStateRow, userTurn: string): string {
  const t = userTurn.toLowerCase();

  // "X tech" / "X-tech" / "Xtech" — catches defence tech, agritech, climatetech.
  const techMatch = t.match(/\b([a-z]{3,20})[\s-]?tech\b/);
  if (techMatch?.[1]) {
    const root = techMatch[1];
    if (!COMMON_WORDS.has(root)) return `${root} tech`;
  }

  // "in X" phrases — "in defence", "in agri", "in climate".
  const inMatch = t.match(/\bin\s+([a-z]{3,20})\b/);
  if (inMatch?.[1] && !COMMON_WORDS.has(inMatch[1])) {
    return inMatch[1];
  }

  // Structured state — only useful if the LLM mapped to a taxonomy slug.
  if (state.sector.length > 0) {
    return state.sector[0]!;
  }

  // must_have free-text — look for short phrases that read like a domain.
  for (const phrase of state.mustHave) {
    const trimmed = phrase.trim().toLowerCase();
    if (trimmed.length > 0 && trimmed.length < 30 && !/\s(should|need|want|prefer)\s/.test(trimmed)) {
      return trimmed;
    }
  }

  return "";
}

/**
 * Domain keywords we'll cross-check against the card. Keyed by the normalised
 * asked-domain string so we can handle common synonyms.
 */
const DOMAIN_SYNONYMS: Record<string, string[]> = {
  defence: ["defence", "defense", "military", "dod", "dual-use", "aerospace"],
  "defence tech": ["defence", "defense", "military", "dod", "dual-use", "aerospace"],
  agri: ["agri", "agriculture", "agtech", "agritech", "farm"],
  "agri tech": ["agri", "agriculture", "agtech", "agritech", "farm"],
  climate: ["climate", "clean", "renewable", "carbon", "sustainab"],
  "climate tech": ["climate", "clean", "renewable", "carbon", "sustainab"],
  health: ["health", "medical", "clinical", "patient", "doctor"],
  healthtech: ["health", "medical", "clinical", "patient", "doctor"],
  fin: ["fintech", "banking", "payments", "lending", "credit"],
  fintech: ["fintech", "banking", "payments", "lending", "credit"],
  edu: ["edtech", "education", "student", "learning"],
  edtech: ["edtech", "education", "student", "learning"],
  space: ["space", "satellite", "orbit", "aerospace"],
  gaming: ["gaming", "game", "esports"],
  logistics: ["logistics", "supply chain", "freight", "shipping"],
};

/** Words that show up inside "in X" / "X tech" but aren't actually domains. */
const COMMON_WORDS = new Set([
  "the", "our", "this", "that", "some", "any", "new", "old", "good", "bad",
  "deep", "pure", "hard", "soft", "high", "low", "mid",
]);

function domainKeywords(askedDomain: string): string[] {
  const norm = askedDomain.toLowerCase().trim();
  if (DOMAIN_SYNONYMS[norm]) return DOMAIN_SYNONYMS[norm]!;
  const root = norm.split(/\s+/)[0]!;
  if (DOMAIN_SYNONYMS[root]) return DOMAIN_SYNONYMS[root]!;
  return [norm, root];
}

export function detectSectorGap(
  state: SearchStateRow,
  userTurn: string,
  card: CardLike,
): SectorGapResult {
  const askedDomain = extractAskedDomain(state, userTurn);
  if (!askedDomain) return { gap: false, askedDomain: "" };

  const keywords = domainKeywords(askedDomain);
  const haystack = [
    card.headline,
    card.rationale ?? "",
    ...(card.bullets ?? []),
    ...card.sector_tags,
  ]
    .join(" ")
    .toLowerCase();

  const hit = keywords.some((kw) => haystack.includes(kw));
  return { gap: !hit, askedDomain };
}
