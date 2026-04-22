import { describe, expect, it, vi } from "vitest";
import {
  findCofoundersSchema,
  handleFindCofounders,
} from "../../../src/agent/tools/find_cofounders.js";
import type { CandidateCard, RankedResult } from "../../../src/matching/pipeline.js";

function card(overrides: Partial<CandidateCard> = {}): CandidateCard {
  return {
    founder_id: "founder-1",
    name: "Asha Kumar",
    city: "Bangalore",
    headline: "Enterprise sales lead",
    rationale: "Strong B2B overlap",
    bullets: ["8 yrs B2B sales"],
    drawback: "",
    intro_recommendation: "warm",
    hold_reason: "",
    score: 9,
    seniority: "founder-level",
    years_exp: 8,
    sector_tags: ["b2b-saas"],
    stage_tags: ["seed"],
    ...overrides,
  };
}

describe("find_cofounders tool", () => {
  it("returns stripped candidate summaries", async () => {
    const runMatching = vi.fn<[unknown], Promise<RankedResult>>().mockResolvedValue({
      cards: [card()],
      retrieved: [],
    });
    const recordShown = vi.fn().mockResolvedValue(true);

    const result = await handleFindCofounders(
      { query: "find me a sales cofounder", limit: 3 },
      {
        requesterId: "req-1",
        conversationId: "conv-1",
        getState: vi.fn().mockResolvedValue({
          conversationId: "conv-1",
          role: null, sector: [], stage: [], location: [],
          seniority: null, mustHave: [], niceToHave: [], antiPrefs: [],
        }),
        getShownFounderIds: vi.fn().mockResolvedValue([]),
        runMatching,
        recordShown,
      },
    );

    expect(result.founders).toHaveLength(1);
    expect(result.founders[0]).toEqual({
      id: "founder-1",
      name: "Asha Kumar",
      city: "Bangalore",
      headline: "Enterprise sales lead",
      rationale: "Strong B2B overlap",
      fit: "warm",
    });
    expect(recordShown).toHaveBeenCalledOnce();
  });

  it("returns empty list + message when no candidates match", async () => {
    const result = await handleFindCofounders(
      { query: "defence tech cofounder" },
      {
        requesterId: "req-1",
        conversationId: "conv-1",
        getState: vi.fn().mockResolvedValue({
          conversationId: "conv-1",
          role: null, sector: [], stage: [], location: [],
          seniority: null, mustHave: [], niceToHave: [], antiPrefs: [],
        }),
        getShownFounderIds: vi.fn().mockResolvedValue([]),
        runMatching: vi.fn().mockResolvedValue({ cards: [], retrieved: [] }),
        recordShown: vi.fn(),
      },
    );

    expect(result.founders).toHaveLength(0);
    expect(result.message).toMatch(/no matches/i);
  });

  it("caps limit at 5 even if agent asks for more", async () => {
    const manyCards = Array.from({ length: 10 }, (_, i) =>
      card({ founder_id: `f-${i}`, name: `F ${i}` }));
    const result = await handleFindCofounders(
      { query: "any", limit: 9 },
      {
        requesterId: "req-1",
        conversationId: "conv-1",
        getState: vi.fn().mockResolvedValue({
          conversationId: "conv-1",
          role: null, sector: [], stage: [], location: [],
          seniority: null, mustHave: [], niceToHave: [], antiPrefs: [],
        }),
        getShownFounderIds: vi.fn().mockResolvedValue([]),
        runMatching: vi.fn().mockResolvedValue({ cards: manyCards, retrieved: [] }),
        recordShown: vi.fn().mockResolvedValue(true),
      },
    );
    expect(result.founders.length).toBeLessThanOrEqual(5);
  });

  it("has a Gemini tool schema", () => {
    expect(findCofoundersSchema.required).toContain("query");
  });
});
