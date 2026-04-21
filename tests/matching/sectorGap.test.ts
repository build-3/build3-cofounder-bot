import { describe, expect, it } from "vitest";
import {
  detectSectorGap,
  extractAskedDomain,
} from "../../src/matching/sector_gap.js";
import type { SearchStateRow } from "../../src/conversation/store.js";

function emptyState(overrides: Partial<SearchStateRow> = {}): SearchStateRow {
  return {
    conversationId: "conv-1",
    role: null,
    sector: [],
    stage: [],
    location: [],
    seniority: null,
    mustHave: [],
    niceToHave: [],
    antiPrefs: [],
    ...overrides,
  };
}

describe("extractAskedDomain", () => {
  it("pulls 'defence tech' from user turn", () => {
    expect(extractAskedDomain(emptyState(), "find me a technical founder in defence tech")).toBe(
      "defence tech",
    );
  });

  it("pulls a standalone 'in X' phrase", () => {
    expect(extractAskedDomain(emptyState(), "looking for someone in climate")).toBe("climate");
  });

  it("ignores filler words like 'in the' or 'in that'", () => {
    expect(extractAskedDomain(emptyState(), "show me someone in the bay area")).not.toBe("the");
  });

  it("falls back to structured state.sector when the turn has no phrase", () => {
    const state = emptyState({ sector: ["fintech"] });
    expect(extractAskedDomain(state, "yes please")).toBe("fintech");
  });

  it("returns empty when nothing usable", () => {
    expect(extractAskedDomain(emptyState(), "yes")).toBe("");
  });
});

describe("detectSectorGap", () => {
  it("flags a gap when user asks defence tech but card is b2b-saas", () => {
    const result = detectSectorGap(
      emptyState(),
      "find me a technical founder in defence tech",
      {
        headline: "Engineer building in b2b-saas. Looking for a non-tech cofounder.",
        sector_tags: ["b2b-saas"],
        bullets: ["Infra/platform engineer."],
      },
    );
    expect(result.gap).toBe(true);
    expect(result.askedDomain).toBe("defence tech");
  });

  it("does not flag when the card mentions the asked domain", () => {
    const result = detectSectorGap(
      emptyState(),
      "find me a technical founder in defence tech",
      {
        headline: "Ex-DoD engineer building dual-use defence systems.",
        sector_tags: ["defence"],
      },
    );
    expect(result.gap).toBe(false);
  });

  it("does not flag when no domain was asked", () => {
    const result = detectSectorGap(emptyState(), "find me a sales cofounder", {
      headline: "GTM operator in climate.",
      sector_tags: ["climate"],
    });
    expect(result.gap).toBe(false);
    expect(result.askedDomain).toBe("");
  });

  it("recognises synonyms (agritech vs agriculture)", () => {
    const result = detectSectorGap(emptyState(), "looking for an agritech cofounder", {
      headline: "Founder building in agriculture.",
      sector_tags: ["agri"],
    });
    expect(result.gap).toBe(false);
  });

  it("uses structured state.sector as a fallback signal", () => {
    const state = emptyState({ sector: ["fintech"] });
    const result = detectSectorGap(state, "keep going", {
      headline: "Engineer in climate analytics.",
      sector_tags: ["climate"],
    });
    expect(result.gap).toBe(true);
  });
});
