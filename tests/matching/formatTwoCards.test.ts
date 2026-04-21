import { describe, expect, it } from "vitest";
import {
  formatTwoCardsText,
  shouldShowTwo,
  type CandidateCard,
} from "../../src/matching/pipeline.js";

function makeCard(overrides: Partial<CandidateCard> = {}): CandidateCard {
  return {
    founder_id: "00000000-0000-0000-0000-000000000000",
    name: "Anuj Rathi",
    city: "Bangalore",
    headline: "Ex Swiggy / Cleartrip growth leader",
    score: 9,
    rationale: "Strong GTM operator",
    bullets: ["ex Swiggy / Cleartrip growth leader", "marketplace reps at real scale"],
    drawback: "hunting a technical cofounder himself, so this may be a notes-swap",
    intro_recommendation: "warm",
    hold_reason: "",
    seniority: "founder-level",
    years_exp: 12,
    sector_tags: ["b2b-saas"],
    stage_tags: ["pre-seed"],
    ...overrides,
  };
}

describe("formatTwoCardsText (B1 two-candidate render)", () => {
  it("renders two numbered cards with header, bullets, drawback, and typed-reply CTA", () => {
    const a = makeCard({ name: "Anuj Rathi" });
    const b = makeCard({
      name: "Shubham Shah",
      founder_id: "11111111-1111-1111-1111-111111111111",
      score: 7,
      bullets: ["CTO office at Varaha (climate)", "built a 20k-ticket community"],
      drawback: "reads more operator than CEO — test fundraising appetite early.",
    });

    const body = formatTwoCardsText([a, b]);

    expect(body).toContain("Here are two worth looking at:");
    expect(body).toContain("1) *Anuj Rathi* — Bangalore");
    expect(body).toContain("2) *Shubham Shah* — Bangalore");
    expect(body).toContain("• ex Swiggy / Cleartrip growth leader");
    expect(body).toContain("• CTO office at Varaha");
    expect(body).toMatch(/Potential drawback: hunting a technical cofounder/);
    expect(body).toMatch(/Potential drawback: reads more operator than CEO/);
    expect(body).toContain("Reply *1* or *2* to pick one, *Skip* to see others.");
  });

  it("omits drawback lines when they're blank", () => {
    const a = makeCard({ drawback: "" });
    const b = makeCard({
      founder_id: "22222222-2222-2222-2222-222222222222",
      drawback: "",
    });
    const body = formatTwoCardsText([a, b]);
    expect(body).not.toContain("Potential drawback:");
  });
});

describe("shouldShowTwo confidence gate", () => {
  it("shows two when the runner-up is within 60% of the top score", () => {
    const a = makeCard({ score: 10 });
    const b = makeCard({ score: 7 });
    expect(shouldShowTwo([a, b])).toBe(true);
  });

  it("shows one when the runner-up is a weak follow-up", () => {
    const a = makeCard({ score: 10 });
    const b = makeCard({ score: 4 });
    expect(shouldShowTwo([a, b])).toBe(false);
  });

  it("shows one when either card is a hold (avoids ambiguous Force-intro CTA)", () => {
    const a = makeCard({ score: 10 });
    const b = makeCard({
      score: 9,
      intro_recommendation: "hold",
      hold_reason: "wants funded startups",
    });
    expect(shouldShowTwo([a, b])).toBe(false);
  });

  it("shows one when there's only one card", () => {
    expect(shouldShowTwo([makeCard()])).toBe(false);
    expect(shouldShowTwo([])).toBe(false);
  });
});
