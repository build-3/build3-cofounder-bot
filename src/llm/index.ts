import { loadConfig } from "../lib/config.js";
import { geminiProvider } from "./gemini.js";
import { openaiProvider } from "./openai.js";
import type { LLMProvider } from "./provider.js";

let _provider: LLMProvider | null = null;

export function getLLM(): LLMProvider {
  if (_provider) return _provider;
  const cfg = loadConfig();
  _provider = cfg.LLM_PROVIDER === "gemini" ? geminiProvider : openaiProvider;
  return _provider;
}

/** Test-time override. Do not use in production code paths. */
export function __setLLMForTests(p: LLMProvider | null) {
  _provider = p;
}

export type { LLMProvider } from "./provider.js";
