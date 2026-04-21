import { afterEach, describe, expect, it } from "vitest";
import { __setLLMForTests } from "../../src/llm/index.js";
import type {
  JsonCallOptions,
  LLMMessage,
  LLMProvider,
} from "../../src/llm/provider.js";
import { rerank } from "../../src/matching/reranker.js";
import type { RetrievedCandidate } from "../../src/matching/retriever.js";
import type { SearchStateRow } from "../../src/conversation/store.js";

function makeCandidate(id: string, overrides: Partial<RetrievedCandidate> = {}): RetrievedCandidate {
  return {
    founder_id: id,
    name: "Anuj Rathi",
    city: "Bangalore",
    headline: "Ex Swiggy / Cleartrip growth leader",
    summary: "Scaled marketplaces at real scale. Now building an AI matchmaking product.",
    role_tags: ["growth", "gtm"],
    sector_tags: ["b2b-saas"],
    stage_tags: ["pre-seed"],
    seniority: "founder-level",
    years_exp: 12,
    distance: 0.12,
    ...overrides,
  };
}

const emptyState: SearchStateRow = {
  conversationId: "c0000000-0000-0000-0000-000000000000",
  role: null,
  sector: [],
  stage: [],
  location: [],
  seniority: null,
  mustHave: [],
  niceToHave: [],
  antiPrefs: [],
};

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

describe("rerank (v3 schema)", () => {
  it("returns bullets and drawback on a well-formed v3 response", async () => {
    const id = "11111111-1111-1111-1111-111111111111";
    __setLLMForTests(
      stubLLM({
        ranked: [
          {
            founder_id: id,
            score: 9,
            rationale: "Strong GTM operator with matchmaking context",
            bullets: [
              "Ex Swiggy / Cleartrip growth leader",
              "Building AI matchmaking — actually gets the product",
              "In my network, warm intro available",
            ],
            drawback:
              "Hunting a technical cofounder himself, so this may turn into a notes-swap",
          },
        ],
      }),
    );

    const ranked = await rerank([makeCandidate(id)], emptyState, "find me a growth cofounder");

    expect(ranked).toHaveLength(1);
    expect(ranked[0]!.founder_id).toBe(id);
    expect(ranked[0]!.bullets).toEqual([
      "Ex Swiggy / Cleartrip growth leader",
      "Building AI matchmaking — actually gets the product",
      "In my network, warm intro available",
    ]);
    expect(ranked[0]!.drawback).toMatch(/notes-swap/);
  });

  it("accepts a legacy v2-shape response (no bullets/drawback) by defaulting both", async () => {
    const id = "22222222-2222-2222-2222-222222222222";
    __setLLMForTests(
      stubLLM({
        ranked: [
          {
            founder_id: id,
            score: 7,
            rationale: "Strong GTM fit",
          },
        ],
      }),
    );

    const ranked = await rerank([makeCandidate(id)], emptyState, "growth cofounder");

    expect(ranked).toHaveLength(1);
    expect(ranked[0]!.bullets).toEqual([]);
    expect(ranked[0]!.drawback).toBe("");
    expect(ranked[0]!.rationale).toBe("Strong GTM fit");
  });

  it("falls back to headline-derived bullets when the LLM throws", async () => {
    __setLLMForTests({
      name: "openai",
      async chat(): Promise<string> {
        throw new Error("simulated LLM outage");
      },
      async json<T>(_opts: JsonCallOptions<T>): Promise<T> {
        throw new Error("simulated LLM outage");
      },
      async embed(inputs: string[]): Promise<number[][]> {
        return inputs.map(() => [0]);
      },
    });

    const id = "33333333-3333-3333-3333-333333333333";
    const ranked = await rerank([makeCandidate(id)], emptyState, "growth cofounder");

    expect(ranked).toHaveLength(1);
    expect(ranked[0]!.drawback).toBe("");
    // First bullet is the headline; second is the first sentence of summary.
    expect(ranked[0]!.bullets[0]).toBe("Ex Swiggy / Cleartrip growth leader");
    expect(ranked[0]!.bullets.length).toBeGreaterThan(0);
  });

  it("parses a v4 'hold' response and surfaces the hold_reason", async () => {
    const id = "55555555-5555-5555-5555-555555555555";
    __setLLMForTests(
      stubLLM({
        ranked: [
          {
            founder_id: id,
            score: 8,
            rationale: "GTM operator with strong BD reps",
            bullets: ["head of Growth + BD", "operator energy"],
            drawback: "",
            intro_recommendation: "hold",
            hold_reason: "wants funded startups with real execution budget",
          },
        ],
      }),
    );

    const ranked = await rerank([makeCandidate(id)], emptyState, "growth cofounder");
    expect(ranked).toHaveLength(1);
    expect(ranked[0]!.intro_recommendation).toBe("hold");
    expect(ranked[0]!.hold_reason).toMatch(/funded startups/);
  });

  it("defaults intro_recommendation to 'warm' for a v3-shaped (no recommendation) response", async () => {
    const id = "66666666-6666-6666-6666-666666666666";
    __setLLMForTests(
      stubLLM({
        ranked: [
          {
            founder_id: id,
            score: 9,
            rationale: "Strong fit",
            bullets: ["b"],
            drawback: "",
          },
        ],
      }),
    );
    const ranked = await rerank([makeCandidate(id)], emptyState, "growth cofounder");
    expect(ranked[0]!.intro_recommendation).toBe("warm");
    expect(ranked[0]!.hold_reason).toBe("");
  });

  it("drops hold_reason when intro_recommendation is warm (even if the model sent one)", async () => {
    const id = "77777777-7777-7777-7777-777777777777";
    __setLLMForTests(
      stubLLM({
        ranked: [
          {
            founder_id: id,
            score: 9,
            rationale: "Strong fit",
            bullets: ["b"],
            drawback: "",
            intro_recommendation: "warm",
            hold_reason: "this should be dropped",
          },
        ],
      }),
    );
    const ranked = await rerank([makeCandidate(id)], emptyState, "growth cofounder");
    expect(ranked[0]!.hold_reason).toBe("");
  });

  it("drops hallucinated founder_ids the reranker invented", async () => {
    const realId = "44444444-4444-4444-4444-444444444444";
    const hallucinated = "99999999-9999-9999-9999-999999999999";
    __setLLMForTests(
      stubLLM({
        ranked: [
          { founder_id: hallucinated, score: 10, rationale: "made up", bullets: [], drawback: "" },
          { founder_id: realId, score: 5, rationale: "real fit", bullets: ["real"], drawback: "" },
        ],
      }),
    );

    const ranked = await rerank([makeCandidate(realId)], emptyState, "growth cofounder");

    expect(ranked.map((r) => r.founder_id)).toEqual([realId]);
  });
});
