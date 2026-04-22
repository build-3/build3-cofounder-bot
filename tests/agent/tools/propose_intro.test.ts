import { describe, expect, it, vi } from "vitest";
import { handleProposeIntro, proposeIntroSchema } from "../../../src/agent/tools/propose_intro.js";

describe("propose_intro tool", () => {
  it("calls propose() and returns proposed status", async () => {
    const propose = vi.fn().mockResolvedValue(undefined);
    const result = await handleProposeIntro(
      {
        target_founder_id: "00000000-0000-0000-0000-000000000001",
        requester_note: "strong B2B sales fit",
      },
      {
        requesterId: "req-1",
        propose,
        markAccepted: vi.fn().mockResolvedValue(undefined),
      },
    );

    expect(result.status).toBe("proposed");
    expect(propose).toHaveBeenCalledWith({
      requesterId: "req-1",
      targetId: "00000000-0000-0000-0000-000000000001",
      requesterNote: "strong B2B sales fit",
    });
  });

  it("maps errors to error status without throwing", async () => {
    const propose = vi.fn().mockRejectedValue(new Error("already exists"));
    const result = await handleProposeIntro(
      { target_founder_id: "00000000-0000-0000-0000-000000000001", requester_note: "x" },
      {
        requesterId: "req-1",
        propose,
        markAccepted: vi.fn().mockResolvedValue(undefined),
      },
    );
    expect(result.status).toBe("error");
    expect(result.message).toContain("already exists");
  });

  it("requires target_founder_id and requester_note", () => {
    expect(proposeIntroSchema.required).toContain("target_founder_id");
    expect(proposeIntroSchema.required).toContain("requester_note");
  });
});
