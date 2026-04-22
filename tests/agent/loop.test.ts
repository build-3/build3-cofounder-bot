import { describe, expect, it, vi } from "vitest";
import { runAgent } from "../../src/agent/loop.js";
import { __setLLMForTests } from "../../src/llm/index.js";
import type {
  AgentLoopOptions,
  AgentLoopResult,
  LLMProvider,
  ToolCall,
} from "../../src/llm/provider.js";
import type { Founder } from "../../src/identity/gate.js";
import type { CandidateCard } from "../../src/matching/pipeline.js";

function fakeFounder(): Founder {
  return {
    id: "req-1",
    phone: "917397599542",
    name: "Arjun Thekkedan",
    city: "Bangalore",
    headline: "Founder, consumer fintech",
    summary: "",
    roleTags: [],
    sectorTags: [],
    stageTags: [],
    seniority: "founder-level",
    optedIn: true,
  };
}

function fakeCard(id: string): CandidateCard {
  return {
    founder_id: id,
    name: "Asha",
    city: "Bangalore",
    headline: "Enterprise sales",
    rationale: "B2B overlap",
    bullets: ["8 yrs B2B"],
    drawback: "",
    intro_recommendation: "warm",
    hold_reason: "",
    score: 9,
    seniority: "founder-level",
    years_exp: 8,
    sector_tags: ["b2b-saas"],
    stage_tags: ["seed"],
  };
}

describe("runAgent", () => {
  it("runs find_cofounders → finish_turn happy path and sends one reply", async () => {
    const sent: Array<{ text?: string; buttons?: unknown }> = [];
    const wati = {
      sendText: vi.fn(async (args: { text: string }) => {
        sent.push({ text: args.text });
      }),
      sendButtons: vi.fn(async (args: { body: string; buttons: unknown }) => {
        sent.push({ text: args.body, buttons: args.buttons });
      }),
    };

    let turn = 0;
    const fakeLLM: Partial<LLMProvider> = {
      agentLoop: async (opts: AgentLoopOptions): Promise<AgentLoopResult> => {
        turn = 1;
        await opts.onToolCall({
          name: "find_cofounders",
          args: { query: "sales cofounder" },
        } satisfies ToolCall);
        turn = 2;
        await opts.onToolCall({
          name: "finish_turn",
          args: {
            reply: "Here's one worth a look.\n\n*Asha* — Bangalore\nB2B overlap.\n\nAccept or Skip?",
            buttons: [
              { id: "accept", title: "Accept" },
              { id: "skip", title: "Skip" },
            ],
          },
        } satisfies ToolCall);
        return { completedNaturally: true, toolCallCount: 2, finalText: "" };
      },
    };
    __setLLMForTests(fakeLLM as LLMProvider);

    await runAgent({
      founder: fakeFounder(),
      conversationId: "conv-1",
      userTurn: "find me a sales cofounder",
      wati: wati as never,
      deps: {
        getSearchState: async () => ({
          conversationId: "conv-1",
          role: null, sector: [], stage: [], location: [],
          seniority: null, mustHave: [], niceToHave: [], antiPrefs: [],
        }),
        writeSearchState: async () => undefined,
        getRecentTurns: async () => [],
        getShownFounderIds: async () => [],
        runMatching: async () => ({ cards: [fakeCard("f-1")], retrieved: [] }),
        recordShown: async () => true,
        markShownAction: async () => undefined,
        fetchFounderDetail: async () => null,
        propose: async () => undefined,
      },
    });

    expect(sent).toHaveLength(1);
    expect(sent[0]?.text).toContain("Asha");
    expect(sent[0]?.buttons).toBeDefined();
    expect(turn).toBe(2);

    __setLLMForTests(null);
  });

  it("falls back to static reply when agent throws", async () => {
    const sent: string[] = [];
    const wati = {
      sendText: vi.fn(async (args: { text: string }) => { sent.push(args.text); }),
      sendButtons: vi.fn(),
    };
    const fakeLLM: Partial<LLMProvider> = {
      agentLoop: async () => { throw new Error("boom"); },
    };
    __setLLMForTests(fakeLLM as LLMProvider);

    await runAgent({
      founder: fakeFounder(),
      conversationId: "conv-1",
      userTurn: "hi",
      wati: wati as never,
      deps: {
        getSearchState: async () => ({
          conversationId: "conv-1",
          role: null, sector: [], stage: [], location: [],
          seniority: null, mustHave: [], niceToHave: [], antiPrefs: [],
        }),
        writeSearchState: async () => undefined,
        getRecentTurns: async () => [],
        getShownFounderIds: async () => [],
        runMatching: async () => ({ cards: [], retrieved: [] }),
        recordShown: async () => true,
        markShownAction: async () => undefined,
        fetchFounderDetail: async () => null,
        propose: async () => undefined,
      },
    });

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatch(/snag/i);
    __setLLMForTests(null);
  });

  it("falls back when finish_turn is never called", async () => {
    const sent: string[] = [];
    const wati = {
      sendText: vi.fn(async (args: { text: string }) => { sent.push(args.text); }),
      sendButtons: vi.fn(),
    };
    const fakeLLM: Partial<LLMProvider> = {
      agentLoop: async (opts) => {
        await opts.onToolCall({ name: "find_cofounders", args: { query: "x" } });
        return { completedNaturally: true, toolCallCount: 1, finalText: "" };
      },
    };
    __setLLMForTests(fakeLLM as LLMProvider);

    await runAgent({
      founder: fakeFounder(),
      conversationId: "conv-1",
      userTurn: "hi",
      wati: wati as never,
      deps: {
        getSearchState: async () => ({
          conversationId: "conv-1",
          role: null, sector: [], stage: [], location: [],
          seniority: null, mustHave: [], niceToHave: [], antiPrefs: [],
        }),
        writeSearchState: async () => undefined,
        getRecentTurns: async () => [],
        getShownFounderIds: async () => [],
        runMatching: async () => ({ cards: [], retrieved: [] }),
        recordShown: async () => true,
        markShownAction: async () => undefined,
        fetchFounderDetail: async () => null,
        propose: async () => undefined,
      },
    });

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatch(/snag/i);
    __setLLMForTests(null);
  });
});
