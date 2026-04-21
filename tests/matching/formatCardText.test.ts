import { describe, expect, it } from "vitest";
import { formatCardText, type CandidateCard } from "../../src/matching/pipeline.js";

function makeCard(overrides: Partial<CandidateCard> = {}): CandidateCard {
  return {
    founder_id: "00000000-0000-0000-0000-000000000000",
    name: "Anuj Rathi",
    city: "Bangalore",
    headline: "Ex Swiggy / Cleartrip growth leader",
    score: 9,
    rationale: "Strong GTM operator with matchmaking-product context",
    bullets: [
      "Ex Swiggy / Cleartrip growth leader, scaled marketplaces at real scale",
      "Building an AI matchmaking product — he actually 'gets' what you're doing",
      "In my network, warm intro available",
    ],
    drawback:
      "He's hunting a technical cofounder himself and plans to raise fast, so this may turn into a notes-swap rather than him joining you",
    intro_recommendation: "warm",
    hold_reason: "",
    seniority: "founder-level",
    years_exp: 12,
    sector_tags: ["b2b-saas", "ai-infra"],
    stage_tags: ["pre-seed"],
    ...overrides,
  };
}

describe("formatCardText (rerank_v3 bullet-prose card)", () => {
  it("renders the bullet-prose card shape with a drawback line", () => {
    const body = formatCardText(makeCard());

    expect(body).toContain("*Anuj Rathi* — Bangalore");
    expect(body).toContain("• Ex Swiggy / Cleartrip growth leader");
    expect(body).toContain("• Building an AI matchmaking product");
    expect(body).toContain("• In my network, warm intro available");
    expect(body).toContain("Potential drawback:");
    expect(body).toContain("Reply *Accept* to connect, *Skip* to see the next.");
  });

  it("does NOT render the legacy 'Closest fit right now' header or meta line", () => {
    const body = formatCardText(makeCard());
    expect(body).not.toContain("Closest fit right now");
    expect(body).not.toContain("_Why this could work:_");
    expect(body).not.toContain("Founder-level");
    expect(body).not.toContain("12 yrs");
  });

  it("omits the drawback line entirely when drawback is empty", () => {
    const body = formatCardText(makeCard({ drawback: "" }));
    expect(body).not.toContain("Potential drawback:");
    // bullets still render
    expect(body).toContain("• Ex Swiggy / Cleartrip growth leader");
  });

  it("falls back to the rationale when bullets is empty", () => {
    const body = formatCardText(makeCard({ bullets: [], drawback: "" }));
    expect(body).toContain("Strong GTM operator with matchmaking-product context");
    expect(body).not.toContain("•");
  });

  it("trims blank bullets so a stray empty string never renders", () => {
    const body = formatCardText(
      makeCard({ bullets: ["real bullet", "", "   ", "another real one"] }),
    );
    expect(body).toContain("• real bullet");
    expect(body).toContain("• another real one");
    // no bullet line with only whitespace
    expect(body).not.toMatch(/•\s*\n/);
  });
});
