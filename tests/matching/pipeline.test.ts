import { describe, expect, it } from "vitest";
import {
  formatCardText,
  formatHoldCard,
  type CandidateCard,
} from "../../src/matching/pipeline.js";

function makeCard(overrides: Partial<CandidateCard> = {}): CandidateCard {
  return {
    founder_id: "founder-1",
    name: "Asha Kumar",
    city: "Bangalore",
    headline: "Enterprise sales lead building in B2B SaaS",
    rationale: "Strong B2B overlap and feels like the kind of operator you'd actually want to talk to.",
    bullets: ["8 years in enterprise B2B sales", "Seed-stage experience across fintech"],
    drawback: "",
    intro_recommendation: "warm",
    hold_reason: "",
    score: 9,
    seniority: "founder-level",
    years_exp: 8,
    sector_tags: ["b2b-saas", "fintech"],
    stage_tags: ["seed"],
    ...overrides,
  };
}

describe("formatCardText", () => {
  it("renders warm card with bullets and accept/skip CTA", () => {
    const text = formatCardText(makeCard());

    expect(text).toContain("*Asha Kumar* — Bangalore");
    expect(text).toContain("• 8 years in enterprise B2B sales");
    expect(text).toContain("Reply *Accept* to connect, *Skip* to see the next.");
  });

  it("omits drawback line when empty", () => {
    const text = formatCardText(makeCard({ drawback: "" }));
    expect(text).not.toContain("Potential drawback");
  });

  it("includes drawback when present", () => {
    const text = formatCardText(makeCard({ drawback: "No fintech background" }));
    expect(text).toContain("Potential drawback: No fintech background");
  });

  it("falls back to rationale when bullets array is empty", () => {
    const text = formatCardText(makeCard({ bullets: [] }));
    expect(text).toContain("Strong B2B overlap");
    expect(text).not.toContain("•");
  });

  it("delegates hold cards to formatHoldCard", () => {
    const card = makeCard({ intro_recommendation: "hold", hold_reason: "No sector overlap" });
    const text = formatCardText(card);
    expect(text).toContain("Holding off on this intro: No sector overlap");
    expect(text).toContain("Reply *Force intro* to override");
  });
});

describe("formatHoldCard", () => {
  it("renders hold reason and force-intro CTA", () => {
    const text = formatHoldCard(makeCard({ intro_recommendation: "hold", hold_reason: "Missing sector fit" }));
    expect(text).toContain("*Asha Kumar* — Bangalore");
    expect(text).toContain("Holding off on this intro: Missing sector fit");
    expect(text).toContain("Reply *Force intro* to override, *Skip* to see others.");
  });

  it("uses generic fallback when hold_reason is empty", () => {
    const text = formatHoldCard(makeCard({ intro_recommendation: "hold", hold_reason: "" }));
    expect(text).toContain("Holding off on this intro for now.");
  });
});
