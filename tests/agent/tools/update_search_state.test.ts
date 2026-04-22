import { describe, expect, it, vi } from "vitest";
import {
  updateSearchStateSchema,
  handleUpdateSearchState,
} from "../../../src/agent/tools/update_search_state.js";
import type { SearchStateRow } from "../../../src/conversation/store.js";

function baseState(convId = "conv-1"): SearchStateRow {
  return {
    conversationId: convId,
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

describe("update_search_state tool", () => {
  it("merges role/sector/location into current state", async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    const get = vi.fn().mockResolvedValue(baseState());

    const result = await handleUpdateSearchState(
      { role: "technical", sector: ["b2b-saas"], location: ["Bangalore"] },
      { conversationId: "conv-1", getState: get, writeState: write },
    );

    expect(result.updated.role).toBe("technical");
    expect(result.updated.sector).toEqual(["b2b-saas"]);
    expect(result.updated.location).toEqual(["Bangalore"]);
    expect(write).toHaveBeenCalledOnce();
  });

  it("preserves existing fields when partial delta supplied", async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    const get = vi.fn().mockResolvedValue({
      ...baseState(),
      role: "sales",
      location: ["Delhi"],
    });

    const result = await handleUpdateSearchState(
      { sector: ["fintech"] },
      { conversationId: "conv-1", getState: get, writeState: write },
    );

    expect(result.updated.role).toBe("sales");
    expect(result.updated.location).toEqual(["Delhi"]);
    expect(result.updated.sector).toEqual(["fintech"]);
  });

  it("has a Gemini-compatible tool schema", () => {
    expect(updateSearchStateSchema.type).toBe("object");
    expect(updateSearchStateSchema.properties).toHaveProperty("role");
    expect(updateSearchStateSchema.properties).toHaveProperty("sector");
  });
});
