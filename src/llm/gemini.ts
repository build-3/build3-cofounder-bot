import type { LLMProvider } from "./provider.js";

/**
 * Stub. Kept so feature code can program against `LLMProvider` from day 1.
 * Fill in when we actually wire Gemini. See ADR-003.
 */
export const geminiProvider: LLMProvider = {
  name: "gemini",
  async chat() {
    throw new Error("gemini provider not yet implemented — set LLM_PROVIDER=openai");
  },
  async json<T>(): Promise<T> {
    throw new Error("gemini provider not yet implemented — set LLM_PROVIDER=openai");
  },
  async embed() {
    throw new Error("gemini provider not yet implemented — set LLM_PROVIDER=openai");
  },
};
