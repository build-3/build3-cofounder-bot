import { describe, expect, it } from "vitest";
import { applyDelta, keywordDelta } from "../../src/matching/refinement.js";
import type { SearchStateRow } from "../../src/conversation/store.js";

function baseState(): SearchStateRow {
  return {
    conversationId: "c1",
    role: null,
    sector: [],
    stage: [],
    location: [],
    seniority: null,
    mustHave: [],
    niceToHave: [],
    antiPrefs: [],
  };
}

describe("applyDelta", () => {
  it("adds role and sector on first refinement", () => {
    const next = applyDelta(baseState(), {
      add: { role: "sales", sector: ["fintech"] },
      remove: {},
      anti_prefs: [],
    });
    expect(next.role).toBe("sales");
    expect(next.sector).toEqual(["fintech"]);
  });

  it("unions lists and deduplicates", () => {
    const s = { ...baseState(), sector: ["fintech"] };
    const next = applyDelta(s, {
      add: { sector: ["fintech", "b2b-saas"] },
      remove: {},
      anti_prefs: [],
    });
    expect(next.sector.sort()).toEqual(["b2b-saas", "fintech"]);
  });

  it("removes from lists", () => {
    const s = { ...baseState(), sector: ["fintech", "b2b-saas"] };
    const next = applyDelta(s, {
      add: {},
      remove: { sector: ["fintech"] },
      anti_prefs: [],
    });
    expect(next.sector).toEqual(["b2b-saas"]);
  });

  it("appends anti_prefs and keeps them deduped", () => {
    const s = { ...baseState(), antiPrefs: ["agencies"] };
    const next = applyDelta(s, {
      add: {},
      remove: {},
      anti_prefs: ["agencies", "consulting"],
    });
    expect(next.antiPrefs.sort()).toEqual(["agencies", "consulting"]);
  });

  it("does not mutate the input state (immutability)", () => {
    const s = baseState();
    const snapshot = JSON.stringify(s);
    applyDelta(s, { add: { role: "sales", sector: ["fintech"] }, remove: {}, anti_prefs: ["x"] });
    expect(JSON.stringify(s)).toBe(snapshot);
  });

  it("role/seniority update only when explicitly provided", () => {
    const s = { ...baseState(), role: "technical" as const, seniority: "operator" as const };
    const next = applyDelta(s, { add: {}, remove: {}, anti_prefs: [] });
    expect(next.role).toBe("technical");
    expect(next.seniority).toBe("operator");
  });
});

describe("keywordDelta (fallback extractor)", () => {
  it("extracts role from natural phrases", () => {
    expect(keywordDelta("find me a sales cofounder").add.role).toBe("sales");
    expect(keywordDelta("I want a technical cofounder").add.role).toBe("technical");
    expect(keywordDelta("growth operator needed").add.role).toBe("growth");
    expect(keywordDelta("product PM cofounder").add.role).toBe("product");
  });

  it("picks up sector slugs + b2b → b2b-saas", () => {
    expect(keywordDelta("more B2B please").add.sector).toContain("b2b-saas");
    expect(keywordDelta("fintech and healthtech").add.sector?.sort()).toEqual(["fintech", "healthtech"]);
  });

  it("extracts locations with NCR special-case", () => {
    expect(keywordDelta("Bangalore or NCR").add.location?.sort()).toEqual(["Bangalore", "Delhi NCR"]);
  });

  it("maps 'founder-level / not just an operator' to seniority", () => {
    expect(keywordDelta("must be founder-level, not just an operator").add.seniority).toBe("founder-level");
  });

  it("collects 'not/no/avoid X' into anti_prefs", () => {
    const d = keywordDelta("not agencies, no consulting");
    expect(d.anti_prefs).toEqual(expect.arrayContaining(["agencies", "consulting"]));
  });

  it("returns an empty delta for empty input", () => {
    const d = keywordDelta("");
    expect(d.add).toEqual({});
    expect(d.anti_prefs).toEqual([]);
  });
});
