import { loadConfig } from "../lib/config.js";
import { logger } from "../lib/logger.js";
import type {
  AgentLoopOptions,
  AgentLoopResult,
  EmbedOptions,
  JsonCallOptions,
  LLMMessage,
  LLMProvider,
  ToolCall,
  ToolDefinition,
} from "./provider.js";

const API_ROOT = "https://generativelanguage.googleapis.com/v1beta";

interface GeminiGenerateResponse {
  candidates?: Array<{
    content?: {
      parts?: Array<{ text?: string }>;
    };
    finishReason?: string;
  }>;
  promptFeedback?: {
    blockReason?: string;
  };
}

interface GeminiEmbedResponse {
  embedding?: {
    values?: number[];
  };
}

interface GeminiFunctionCall {
  name: string;
  args: Record<string, unknown>;
}

interface GeminiGenerateWithToolsResponse {
  candidates?: Array<{
    content?: {
      parts?: Array<{
        text?: string;
        functionCall?: GeminiFunctionCall;
      }>;
      role?: string;
    };
    finishReason?: string;
  }>;
  promptFeedback?: { blockReason?: string };
}

function apiKey(): string {
  return loadConfig().GOOGLE_AI_KEY!;
}

function buildHeaders(): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "x-goog-api-key": apiKey(),
  };
}

function buildContents(messages: LLMMessage[]) {
  return messages
    .filter((message) => message.role !== "system")
    .map((message) => ({
      role: message.role === "assistant" ? "model" : "user",
      parts: [{ text: message.content }],
    }));
}

function buildSystemInstruction(messages: LLMMessage[]) {
  const system = messages
    .filter((message) => message.role === "system")
    .map((message) => message.content.trim())
    .filter(Boolean)
    .join("\n\n");

  if (!system) return undefined;
  return { parts: [{ text: system }] };
}

function extractText(response: GeminiGenerateResponse): string {
  const text = response.candidates?.[0]?.content?.parts
    ?.map((part) => part.text ?? "")
    .join("")
    .trim();
  if (text) return text;

  const blockReason = response.promptFeedback?.blockReason ?? response.candidates?.[0]?.finishReason;
  throw new Error(blockReason ? `gemini returned no text (${blockReason})` : "gemini returned no text");
}

function toolsToGeminiFormat(tools: ToolDefinition[]) {
  return [{
    functionDeclarations: tools.map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    })),
  }];
}

async function generate(
  messages: LLMMessage[],
  opts?: { temperature?: number; maxTokens?: number; responseMimeType?: string },
): Promise<string> {
  const cfg = loadConfig();
  const response = await fetch(`${API_ROOT}/models/${cfg.GEMINI_MODEL_CHAT}:generateContent`, {
    method: "POST",
    headers: buildHeaders(),
    body: JSON.stringify({
      contents: buildContents(messages),
      systemInstruction: buildSystemInstruction(messages),
      generationConfig: {
        temperature: opts?.temperature ?? 0.3,
        ...(opts?.maxTokens !== undefined ? { maxOutputTokens: opts.maxTokens } : {}),
        ...(opts?.responseMimeType ? { responseMimeType: opts.responseMimeType } : {}),
      },
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`gemini generateContent ${response.status}: ${body.slice(0, 400)}`);
  }

  return extractText((await response.json()) as GeminiGenerateResponse);
}

export const geminiProvider: LLMProvider = {
  name: "gemini",

  async chat(messages, opts) {
    const config: { temperature?: number; maxTokens?: number } = {};
    if (opts?.temperature !== undefined) config.temperature = opts.temperature;
    if (opts?.maxTokens !== undefined) config.maxTokens = opts.maxTokens;
    return await generate(messages, config);
  },

  async json<T>({ system, user, schemaName, parse, temperature, maxTokens }: JsonCallOptions<T>): Promise<T> {
    let lastErr: unknown;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const config: { temperature?: number; maxTokens?: number; responseMimeType: string } = {
          responseMimeType: "application/json",
        };
        config.temperature = temperature ?? 0;
        if (maxTokens !== undefined) config.maxTokens = maxTokens;
        const raw = await generate(
          [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
          config,
        );
        return parse(raw);
      } catch (err) {
        lastErr = err;
        logger.warn({ schemaName, attempt, err }, "Gemini JSON parse failed");
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(`Gemini JSON parse failed for ${schemaName}`);
  },

  async embed(inputs, opts?: EmbedOptions) {
    const cfg = loadConfig();
    const results = await Promise.all(
      inputs.map(async (input) => {
        const response = await fetch(`${API_ROOT}/models/${cfg.GEMINI_MODEL_EMBED}:embedContent`, {
          method: "POST",
          headers: buildHeaders(),
          body: JSON.stringify({
            content: {
              parts: [{ text: input }],
            },
            ...(opts?.taskType ? { taskType: opts.taskType } : {}),
            outputDimensionality: 1536,
          }),
        });

        if (!response.ok) {
          const body = await response.text().catch(() => "");
          throw new Error(`gemini embedContent ${response.status}: ${body.slice(0, 400)}`);
        }

        const data = (await response.json()) as GeminiEmbedResponse;
        const vector = data.embedding?.values;
        if (!vector?.length) throw new Error("gemini returned empty embedding");
        return vector;
      }),
    );

    return results;
  },

  async agentLoop(opts: AgentLoopOptions): Promise<AgentLoopResult> {
    const cfg = loadConfig();
    const model = opts.model ?? cfg.GEMINI_MODEL_AGENT;

    const history: Array<{
      role: "user" | "model";
      parts: Array<{ text?: string; functionCall?: GeminiFunctionCall; functionResponse?: { name: string; response: Record<string, unknown> } }>;
    }> = opts.messages
      .filter((m) => m.role !== "system")
      .map((m) => ({
        role: m.role === "assistant" ? "model" : "user",
        parts: [{ text: m.content }],
      }));

    const systemInstruction = opts.system.trim()
      ? { parts: [{ text: opts.system.trim() }] }
      : undefined;

    let iterations = 0;
    let finalText = "";

    while (iterations < opts.maxIterations) {
      iterations += 1;

      const response = await fetch(`${API_ROOT}/models/${model}:generateContent`, {
        method: "POST",
        headers: buildHeaders(),
        body: JSON.stringify({
          contents: history,
          systemInstruction,
          tools: toolsToGeminiFormat(opts.tools),
          // Force Gemini to emit a function call every step. Without this, the
          // model can respond with free text (no functionCall) and the loop
          // returns cleanly with no finish_turn — the runAgent caller then
          // has no payload and falls back to "Hit a snag". Seen in prod with
          // the real system prompt despite a "MUST call finish_turn" instruction.
          toolConfig: {
            functionCallingConfig: { mode: "ANY" },
          },
          generationConfig: {
            temperature: opts.temperature ?? 0.9,
          },
        }),
      });

      if (!response.ok) {
        const body = await response.text();
        throw new Error(`gemini agent call failed: ${response.status} ${body.slice(0, 200)}`);
      }

      const json = (await response.json()) as GeminiGenerateWithToolsResponse;
      const parts = json.candidates?.[0]?.content?.parts ?? [];

      const functionCalls = parts
        .map((p) => p.functionCall)
        .filter((c): c is GeminiFunctionCall => Boolean(c));
      const textParts = parts.map((p) => p.text ?? "").filter(Boolean).join("");

      if (textParts) finalText = textParts;

      history.push({ role: "model", parts });

      if (functionCalls.length === 0) {
        return { completedNaturally: true, toolCallCount: iterations - 1, finalText };
      }

      for (const call of functionCalls) {
        const toolCall: ToolCall = { name: call.name, args: call.args ?? {} };
        let result: unknown;
        try {
          result = await opts.onToolCall(toolCall);
        } catch (err) {
          result = { error: err instanceof Error ? err.message : "tool threw" };
        }
        history.push({
          role: "user",
          parts: [{
            functionResponse: {
              name: call.name,
              response: result as Record<string, unknown> ?? {},
            },
          }],
        });
      }
    }

    logger.warn({ maxIterations: opts.maxIterations }, "agent loop hit iteration cap");
    return { completedNaturally: false, toolCallCount: iterations, finalText };
  },
};
