import OpenAI from "openai";
import { loadConfig } from "../lib/config.js";
import { logger } from "../lib/logger.js";
import type { AgentLoopResult, EmbedOptions, JsonCallOptions, LLMMessage, LLMProvider } from "./provider.js";

let _client: OpenAI | null = null;
function client() {
  if (_client) return _client;
  const cfg = loadConfig();
  _client = new OpenAI({ apiKey: cfg.OPENAI_API_KEY! });
  return _client;
}

export const openaiProvider: LLMProvider = {
  name: "openai",

  async chat(messages, opts) {
    const cfg = loadConfig();
    const res = await client().chat.completions.create({
      model: cfg.OPENAI_MODEL_CHAT,
      messages: messages as LLMMessage[],
      temperature: opts?.temperature ?? 0.3,
      ...(opts?.maxTokens !== undefined ? { max_tokens: opts.maxTokens } : {}),
    });
    return res.choices[0]?.message?.content ?? "";
  },

  async json<T>({ system, user, schemaName, parse, temperature, maxTokens }: JsonCallOptions<T>): Promise<T> {
    const cfg = loadConfig();
    // One retry on parse failure before callers fall back to a deterministic path.
    let lastErr: unknown;
    for (let attempt = 1; attempt <= 2; attempt++) {
      const res = await client().chat.completions.create({
        model: cfg.OPENAI_MODEL_CHAT,
        response_format: { type: "json_object" },
        temperature: temperature ?? 0,
        ...(maxTokens !== undefined ? { max_tokens: maxTokens } : {}),
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      });
      const raw = res.choices[0]?.message?.content ?? "";
      try {
        return parse(raw);
      } catch (err) {
        lastErr = err;
        logger.warn({ schemaName, attempt, raw: raw.slice(0, 400) }, "LLM JSON parse failed");
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(`LLM JSON parse failed for ${schemaName}`);
  },

  async embed(inputs, _opts?: EmbedOptions) {
    const cfg = loadConfig();
    if (inputs.length === 0) return [];
    const res = await client().embeddings.create({
      model: cfg.OPENAI_MODEL_EMBED,
      input: inputs,
    });
    return res.data.map((d) => d.embedding);
  },

  async agentLoop(): Promise<AgentLoopResult> {
    throw new Error("openai provider does not implement agentLoop — use gemini");
  },
};
