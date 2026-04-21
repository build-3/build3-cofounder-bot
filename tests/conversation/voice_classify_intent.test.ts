import { afterEach, describe, expect, it } from "vitest";
import { __setLLMForTests } from "../../src/llm/index.js";
import type {
  JsonCallOptions,
  LLMMessage,
  LLMProvider,
} from "../../src/llm/provider.js";
import { classifyIntent } from "../../src/conversation/voice.js";

function stubLLM(response: unknown): LLMProvider {
  return {
    name: "openai",
    async chat(_messages: LLMMessage[]): Promise<string> {
      return JSON.stringify(response);
    },
    async json<T>(opts: JsonCallOptions<T>): Promise<T> {
      return opts.parse(JSON.stringify(response));
    },
    async embed(inputs: string[]): Promise<number[][]> {
      return inputs.map(() => [0]);
    },
  };
}

afterEach(() => {
  __setLLMForTests(null);
});

describe("classifyIntent — topic_switch (B3)", () => {
  it("returns topic_switch when LLM labels 'find me investors' with high confidence", async () => {
    __setLLMForTests(stubLLM({ intent: "topic_switch", confidence: 0.9 }));
    const out = await classifyIntent({
      text: "actually forget the cofounder, find me investors",
      searchActive: true,
      recentTurns: [],
    });
    expect(out.intent).toBe("topic_switch");
    expect(out.confidence).toBeGreaterThanOrEqual(0.7);
  });

  it("demotes a low-confidence topic_switch to 'other' so the router asks a clarifying question", async () => {
    __setLLMForTests(stubLLM({ intent: "topic_switch", confidence: 0.5 }));
    const out = await classifyIntent({
      text: "hmm maybe something else",
      searchActive: true,
      recentTurns: [],
    });
    expect(out.intent).toBe("other");
    expect(out.confidence).toBe(0.5);
  });

  it("heuristic fallback catches 'find me investors' when the LLM errors", async () => {
    __setLLMForTests({
      name: "openai",
      async chat(): Promise<string> {
        throw new Error("LLM down");
      },
      async json<T>(_opts: JsonCallOptions<T>): Promise<T> {
        throw new Error("LLM down");
      },
      async embed(inputs: string[]): Promise<number[][]> {
        return inputs.map(() => [0]);
      },
    });
    const out = await classifyIntent({
      text: "find me investors",
      searchActive: true,
      recentTurns: [],
    });
    expect(out.intent).toBe("topic_switch");
  });

  it("recognizes FORCE_INTRO button payload deterministically (no LLM)", async () => {
    // Pass an LLM that would throw if called — proves we short-circuit.
    __setLLMForTests({
      name: "openai",
      async chat(): Promise<string> {
        throw new Error("should not be called");
      },
      async json<T>(_opts: JsonCallOptions<T>): Promise<T> {
        throw new Error("should not be called");
      },
      async embed(inputs: string[]): Promise<number[][]> {
        return inputs.map(() => [0]);
      },
    });
    const out = await classifyIntent({
      buttonPayload: "FORCE_INTRO",
      searchActive: true,
      recentTurns: [],
    });
    expect(out.intent).toBe("force_intro");
    expect(out.confidence).toBe(1);
  });

  it("resolves typed 'force intro' / 'intro anyway' to force_intro", async () => {
    __setLLMForTests({
      name: "openai",
      async chat(): Promise<string> {
        throw new Error("should not be called");
      },
      async json<T>(_opts: JsonCallOptions<T>): Promise<T> {
        throw new Error("should not be called");
      },
      async embed(inputs: string[]): Promise<number[][]> {
        return inputs.map(() => [0]);
      },
    });
    for (const text of ["force intro", "Intro anyway", "reach out anyway", "I'll take it"]) {
      const out = await classifyIntent({ text, searchActive: true, recentTurns: [] });
      expect(out.intent).toBe("force_intro");
    }
  });

  it("resolves a numeric pick '1' / '2' to accept with pick=N (no LLM)", async () => {
    __setLLMForTests({
      name: "openai",
      async chat(): Promise<string> {
        throw new Error("should not be called");
      },
      async json<T>(_opts: JsonCallOptions<T>): Promise<T> {
        throw new Error("should not be called");
      },
      async embed(inputs: string[]): Promise<number[][]> {
        return inputs.map(() => [0]);
      },
    });
    const one = await classifyIntent({ text: "1", searchActive: true, recentTurns: [] });
    expect(one.intent).toBe("accept");
    expect(one.pick).toBe(1);
    const two = await classifyIntent({ text: "pick 2", searchActive: true, recentTurns: [] });
    expect(two.intent).toBe("accept");
    expect(two.pick).toBe(2);
  });

  it("does NOT treat '1 more cofounder please' as a pick", async () => {
    __setLLMForTests(stubLLM({ intent: "refine", confidence: 0.8 }));
    const out = await classifyIntent({
      text: "1 more cofounder please",
      searchActive: true,
      recentTurns: [],
    });
    expect(out.intent).not.toBe("accept");
    expect(out.pick).toBeUndefined();
  });

  it("heuristic does NOT fire topic_switch when 'cofounder' is in the ask", async () => {
    __setLLMForTests({
      name: "openai",
      async chat(): Promise<string> {
        throw new Error("LLM down");
      },
      async json<T>(_opts: JsonCallOptions<T>): Promise<T> {
        throw new Error("LLM down");
      },
      async embed(inputs: string[]): Promise<number[][]> {
        return inputs.map(() => [0]);
      },
    });
    const out = await classifyIntent({
      text: "find me a cofounder who's done fundraising",
      searchActive: true,
      recentTurns: [],
    });
    expect(out.intent).not.toBe("topic_switch");
  });
});
