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
    summary: "8 yrs B2B sales. Looking for a technical cofounder in fintech.",
    rationale: "Strong B2B overlap",
    bullets: ["8 yrs B2B sales"],
    drawback: "",
    intro_recommendation: "warm",
    hold_reason: "",
    score: 78,
    seniority: "founder-level",
    years_exp: 8,
    sector_tags: ["b2b-saas"],
    stage_tags: ["seed"],
    match_score: 78,
    breakdown: { role_fit: 3, sector_fit: 2 },
    headline_evidence: ["Enterprise sales lead"],
    times_shown: 0,
    ...overrides,
  };
}

describe("find_cofounders tool", () => {
  it("returns the top single card with rich detail + match score", async () => {
    const runMatching = vi.fn<[unknown], Promise<RankedResult>>().mockResolvedValue({
      cards: [card()],
      retrieved: [],
    });
    const recordShown = vi.fn().mockResolvedValue(true);

    const result = await handleFindCofounders(
      { query: "find me a sales cofounder" },
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

    expect(result.founder).not.toBeNull();
    expect(result.founder).toMatchObject({
      id: "founder-1",
      name: "Asha Kumar",
      city: "Bangalore",
      headline: "Enterprise sales lead",
      rationale: "Strong B2B overlap",
      fit: "warm",
      match_score: 78,
      breakdown: { role_fit: 3, sector_fit: 2 },
      headline_evidence: ["Enterprise sales lead"],
      times_shown: 0,
    });
    expect(recordShown).toHaveBeenCalledOnce();
  });

  it("returns founder=null + message when no candidates match", async () => {
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

    expect(result.founder).toBeNull();
    expect(result.message).toMatch(/no matches/i);
  });

  it("only shows the top candidate even when many were ranked", async () => {
    const manyCards = Array.from({ length: 10 }, (_, i) =>
      card({ founder_id: `f-${i}`, name: `F ${i}` }));
    const recordShown = vi.fn().mockResolvedValue(true);
    const result = await handleFindCofounders(
      { query: "any" },
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
        recordShown,
      },
    );
    expect(result.founder).not.toBeNull();
    expect(result.founder?.id).toBe("f-0");
    // Only the top card is recorded as shown.
    expect(recordShown).toHaveBeenCalledOnce();
    const recordedCards = recordShown.mock.calls[0]?.[1] as CandidateCard[];
    expect(recordedCards).toHaveLength(1);
  });

  it("has a Gemini tool schema", () => {
    expect(findCofoundersSchema.required).toContain("query");
  });
});
