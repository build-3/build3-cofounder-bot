import { describe, expect, it } from "vitest";
import { fallbackIntro } from "../../src/llm/prompts/intro_v1.js";

const a = {
  name: "Asha Kumar",
  city: "Bangalore",
  headline: "Growth lead, consumer fintech",
  summary: "-",
};
const b = {
  name: "Rohit Menon",
  city: "Delhi NCR",
  headline: "Tech cofounder, APIs + infra",
  summary: "-",
};

describe("fallbackIntro (deterministic safety net)", () => {
  it("greets both founders by first name", () => {
    const text = fallbackIntro({ a, b, reason: "sector overlap" });
    expect(text).toMatch(/^Hey Asha and Rohit — /);
  });

  it("mentions both cities and both headlines", () => {
    const text = fallbackIntro({ a, b, reason: "sector overlap" });
    expect(text).toContain("Bangalore");
    expect(text).toContain("Delhi NCR");
    expect(text).toContain(a.headline);
    expect(text).toContain(b.headline);
  });

  it("closes with 'Over to you.'", () => {
    const text = fallbackIntro({ a, b, reason: "sector overlap" });
    expect(text.trim().endsWith("Over to you.")).toBe(true);
  });

  it("substitutes a default when reason is empty", () => {
    const text = fallbackIntro({ a, b, reason: "" });
    expect(text).toContain("overlapping cofounder intent");
  });

  it("never leaks the summary field (privacy invariant)", () => {
    const sensitive = {
      ...a,
      summary: "SECRET-FINANCIAL-INFO-DO-NOT-SHARE",
    };
    const text = fallbackIntro({ a: sensitive, b, reason: "r" });
    expect(text).not.toContain("SECRET-FINANCIAL-INFO-DO-NOT-SHARE");
  });
});
