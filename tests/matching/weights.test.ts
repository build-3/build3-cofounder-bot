import { describe, expect, it } from "vitest";
import { DEFAULT_WEIGHTS, assembleQuery } from "../../src/matching/weights.js";

function baseState() {
  return {
    role: null as string | null,
    sector: [] as string[],
    stage: [] as string[],
    location: [] as string[],
    seniority: null as string | null,
    mustHave: [] as string[],
    niceToHave: [] as string[],
  };
}

describe("assembleQuery", () => {
  it("always appends the user turn at the end", () => {
    const q = assembleQuery(baseState(), "hello world");
    expect(q.trim().endsWith("User message: hello world")).toBe(true);
  });

  it("repeats the role clause in proportion to role_tags weight (~3x at 0.35)", () => {
    const q = assembleQuery({ ...baseState(), role: "sales" }, "find me someone");
    const matches = q.match(/Looking for a sales cofounder/g) ?? [];
    expect(matches.length).toBe(Math.max(1, Math.round(DEFAULT_WEIGHTS.role_tags * 10)));
    expect(matches.length).toBeGreaterThanOrEqual(3);
  });

  it("repeats the sector clause in proportion to sector_tags weight (~2x at 0.20)", () => {
    const q = assembleQuery({ ...baseState(), sector: ["fintech", "b2b-saas"] }, "...");
    const matches = q.match(/Sectors: fintech, b2b-saas/g) ?? [];
    expect(matches.length).toBe(Math.max(1, Math.round(DEFAULT_WEIGHTS.sector_tags * 10)));
  });

  it("renders stage, seniority, location, must-have, nice-to-have when present", () => {
    const q = assembleQuery(
      {
        ...baseState(),
        stage: ["seed"],
        seniority: "founder-level",
        location: ["Bangalore", "Delhi NCR"],
        mustHave: ["shipped production software"],
        niceToHave: ["prior exit"],
      },
      "find me someone",
    );
    expect(q).toContain("Stage focus: seed");
    expect(q).toContain("Seniority: founder-level");
    expect(q).toContain("Location preference: Bangalore, Delhi NCR");
    expect(q).toContain("Must have: shipped production software");
    expect(q).toContain("Nice to have: prior exit");
  });

  it("omits empty fields rather than emitting blanks", () => {
    const q = assembleQuery(baseState(), "hi");
    expect(q).not.toContain("Looking for a");
    expect(q).not.toContain("Sectors:");
    expect(q).not.toContain("Stage focus:");
    expect(q).not.toContain("Seniority:");
    expect(q).not.toContain("Location preference:");
    expect(q).not.toContain("Must have:");
    expect(q).not.toContain("Nice to have:");
  });

  it("respects a custom weights map", () => {
    const q = assembleQuery(
      { ...baseState(), role: "growth" },
      "...",
      { ...DEFAULT_WEIGHTS, role_tags: 0.1 }, // ~1 repetition
    );
    const matches = q.match(/Looking for a growth cofounder/g) ?? [];
    expect(matches.length).toBe(1);
  });
});

describe("DEFAULT_WEIGHTS", () => {
  it("keeps skills_raw at zero (ADR-004)", () => {
    expect(DEFAULT_WEIGHTS.skills_raw).toBe(0);
  });

  it("has role as the highest-weighted field", () => {
    const { role_tags, sector_tags, stage_tags, location, seniority, summary_semantic } =
      DEFAULT_WEIGHTS;
    for (const w of [sector_tags, stage_tags, location, seniority, summary_semantic]) {
      expect(role_tags).toBeGreaterThan(w);
    }
  });
});
