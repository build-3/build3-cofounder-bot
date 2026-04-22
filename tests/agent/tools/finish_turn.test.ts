import { describe, expect, it } from "vitest";
import { finishTurnSchema, handleFinishTurn } from "../../../src/agent/tools/finish_turn.js";

describe("finish_turn tool", () => {
  it("accepts a plain reply", () => {
    const result = handleFinishTurn({ reply: "Hey there" });
    expect(result).toEqual({ reply: "Hey there", cleanFinish: true });
  });

  it("accepts a reply with up to 2 buttons", () => {
    const result = handleFinishTurn({
      reply: "Match found",
      buttons: [
        { id: "accept", title: "Accept" },
        { id: "skip", title: "Skip" },
      ],
    });
    expect(result.buttons).toHaveLength(2);
  });

  it("rejects more than 2 buttons (WATI session cap)", () => {
    expect(() =>
      handleFinishTurn({
        reply: "x",
        buttons: [
          { id: "a", title: "A" },
          { id: "b", title: "B" },
          { id: "c", title: "C" },
        ],
      }),
    ).toThrow(/max 2 buttons/i);
  });

  it("rejects empty reply", () => {
    expect(() => handleFinishTurn({ reply: "" })).toThrow(/empty reply/i);
  });

  it("has a tool schema with reply required", () => {
    expect(finishTurnSchema.required).toContain("reply");
  });
});
