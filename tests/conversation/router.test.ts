import { describe, expect, it } from "vitest";
import { classifyIntent } from "../../src/conversation/router.js";

describe("classifyIntent", () => {
  it("maps button payloads to accept/skip/decline", () => {
    expect(classifyIntent({ buttonPayload: "ACCEPT" })).toBe("accept");
    expect(classifyIntent({ buttonPayload: "SKIP" })).toBe("skip");
    expect(classifyIntent({ buttonPayload: "DECLINE" })).toBe("decline");
    expect(classifyIntent({ buttonPayload: "accept" })).toBe("accept"); // case-insensitive
  });

  it("recognizes typed 'accept', 'skip', 'decline' (standalone)", () => {
    expect(classifyIntent({ text: "Accept" })).toBe("accept");
    expect(classifyIntent({ text: "  skip  " })).toBe("skip");
    expect(classifyIntent({ text: "DECLINE" })).toBe("decline");
  });

  it("does not match 'accept' embedded in a sentence", () => {
    // "I accept any sector" should refine, not trigger consent
    expect(classifyIntent({ text: "I accept any sector" })).toBe("refine");
  });

  it("recognizes hello/help variants", () => {
    expect(classifyIntent({ text: "hi" })).toBe("help");
    expect(classifyIntent({ text: "Hello" })).toBe("help");
    expect(classifyIntent({ text: "help" })).toBe("help");
    expect(classifyIntent({ text: "start" })).toBe("help");
  });

  it("classifies discover-y requests", () => {
    expect(classifyIntent({ text: "find me a sales cofounder" })).toBe("discover");
    expect(classifyIntent({ text: "looking for a technical co-founder" })).toBe("discover");
    expect(classifyIntent({ text: "I want a growth cofounder" })).toBe("discover");
    expect(classifyIntent({ text: "technical cofounder" })).toBe("discover");
  });

  it("treats other text as refinement", () => {
    expect(classifyIntent({ text: "more B2B" })).toBe("refine");
    expect(classifyIntent({ text: "fintech preferred" })).toBe("refine");
    expect(classifyIntent({ text: "Bangalore or NCR" })).toBe("refine");
  });

  it("returns 'other' for empty inputs", () => {
    expect(classifyIntent({})).toBe("other");
    expect(classifyIntent({ text: "" })).toBe("other");
  });

  it("button payload wins over text", () => {
    expect(classifyIntent({ text: "random text", buttonPayload: "ACCEPT" })).toBe("accept");
  });
});
