import { describe, expect, it } from "vitest";
import {
  formatCardText,
  formatHoldCard,
  type CandidateCard,
} from "../../src/matching/pipeline.js";

function makeHoldCard(overrides: Partial<CandidateCard> = {}): CandidateCard {
  return {
    founder_id: "00000000-0000-0000-0000-000000000000",
    name: "Santhosh Katkurwar",
    city: "Bangalore",
    headline: "Head of Growth + BD with sell-build-fundraise reps",
    score: 8,
    rationale: "GTM + BD operator with founder-adjacent reps",
    bullets: [
      "head of Growth + BD with sell-build-fundraise reps",
      "thinks in GTM systems, operator energy",
    ],
    drawback: "",
    intro_recommendation: "hold",
    hold_reason:
      "he explicitly wants funded startups with real execution budget; you're pre-product",
    seniority: "founder-level",
    years_exp: 12,
    sector_tags: ["b2b-saas"],
    stage_tags: ["seed"],
    ...overrides,
  };
}

describe("formatHoldCard (rerank_v4 hold)", () => {
  it("renders hold reason instead of a drawback and the Force intro CTA", () => {
    const body = formatHoldCard(makeHoldCard());
    expect(body).toContain("*Santhosh Katkurwar* — Bangalore");
    expect(body).toContain("• head of Growth");
    expect(body).toContain("Holding off on this intro:");
    expect(body).toContain("wants funded startups");
    expect(body).toContain("Reply *Force intro* to override, *Skip* to see others.");
    expect(body).not.toContain("Potential drawback:");
    expect(body).not.toContain("Reply *Accept*");
  });

  it("formatCardText routes hold cards to formatHoldCard shape automatically", () => {
    const body = formatCardText(makeHoldCard());
    expect(body).toContain("Holding off on this intro:");
    expect(body).toContain("Reply *Force intro*");
  });

  it("falls back to a generic line when hold_reason is empty", () => {
    const body = formatHoldCard(makeHoldCard({ hold_reason: "" }));
    expect(body).toContain("Holding off on this intro for now.");
    expect(body).toContain("Reply *Force intro*");
  });
});
