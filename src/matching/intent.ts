import { z } from "zod";
import { getLLM } from "../llm/index.js";
import { loadConfig } from "../lib/config.js";
import { logger } from "../lib/logger.js";
import {
  SEARCH_INTENT_SYSTEM,
  buildSearchIntentUserPrompt,
  type SearchIntentInput,
} from "../llm/prompts/search_intent_v2.js";

function intentModel(): string | undefined {
  // Same logic as the reranker. Wrapped because tests stub the LLM provider
  // without bringing up env vars; undefined falls through to the provider
  // default, which the stub ignores anyway.
  try {
    const cfg = loadConfig();
    return cfg.LLM_PROVIDER === "openai" ? cfg.OPENAI_MODEL_RERANK : cfg.GEMINI_MODEL_RERANK;
  } catch {
    return undefined;
  }
}

/**
 * LLM-derived filters the retriever can push directly into the SQL query.
 * Each list is already synonym-expanded; the retriever does NOT add its
 * own synonyms. This is the single source of truth for "what are we
 * searching for right now."
 */
export interface SearchIntent {
  role_tags: string[];
  role_tags_must_not: string[];
  sector_tags: string[];
  stage_tags: string[];
  cities: string[];
  seniority: string | null;
  semantic_query: string;
  notes: string[];
}

const SearchIntentSchema = z.object({
  role_tags: z.array(z.string()).default([]),
  role_tags_must_not: z.array(z.string()).default([]),
  sector_tags: z.array(z.string()).default([]),
  stage_tags: z.array(z.string()).default([]),
  cities: z.array(z.string()).default([]),
  seniority: z.string().nullable().default(null),
  semantic_query: z.string().default(""),
  notes: z.array(z.string()).default([]),
});

/**
 * Resolve the founder's latest ask into DB-ready filters. Always returns a
 * value — if the LLM fails, we fall back to the raw search_state values so
 * the retriever still has something to work with.
 */
export async function resolveSearchIntent(input: SearchIntentInput): Promise<SearchIntent> {
  try {
    const model = intentModel();
    return await getLLM().json({
      system: SEARCH_INTENT_SYSTEM,
      user: buildSearchIntentUserPrompt(input),
      schemaName: "search_intent_v2",
      temperature: 0,
      ...(model ? { model } : {}),
      parse: (raw) => SearchIntentSchema.parse(JSON.parse(raw)),
    });
  } catch (err) {
    logger.warn({ err }, "search_intent LLM failed — using raw state as filters");
    return {
      role_tags: input.currentState.role ? [input.currentState.role] : [],
      role_tags_must_not: [],
      sector_tags: [],
      stage_tags: [],
      cities: [],
      seniority: input.currentState.seniority,
      semantic_query: input.userTurn,
      notes: ["fallback: LLM failed"],
    };
  }
}
