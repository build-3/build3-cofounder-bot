import OpenAI from "openai";
import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources/chat/completions";
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

  async agentLoop(opts: AgentLoopOptions): Promise<AgentLoopResult> {
    const cfg = loadConfig();
    const model = opts.model ?? cfg.OPENAI_MODEL_CHAT;

    const history: ChatCompletionMessageParam[] = [
      { role: "system", content: opts.system },
      ...opts.messages.map((m) => ({ role: m.role, content: m.content }) as ChatCompletionMessageParam),
    ];

    const tools: ChatCompletionTool[] = opts.tools.map((t: ToolDefinition) => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters as unknown as Record<string, unknown>,
      },
    }));

    let iterations = 0;
    let toolCallCount = 0;
    let finalText = "";
    let finished = false;

    while (iterations < opts.maxIterations && !finished) {
      iterations += 1;

      const res = await client().chat.completions.create({
        model,
        messages: history,
        tools,
        // "required" forces a tool call — mirrors Gemini's mode: "ANY".
        // Without this the model can respond with free text and skip
        // finish_turn, leaving the agent loop with no payload.
        tool_choice: "required",
        temperature: opts.temperature ?? 0.9,
      });

      const choice = res.choices[0];
      const message = choice?.message;
      if (!message) {
        throw new Error("openai returned no message");
      }

      if (message.content) finalText = message.content;

      const toolCalls = message.tool_calls ?? [];

      // Push assistant turn (must include tool_calls so tool responses can
      // reference tool_call_id on the next turn).
      history.push({
        role: "assistant",
        content: message.content ?? "",
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      } as ChatCompletionMessageParam);

      if (toolCalls.length === 0) {
        return { completedNaturally: true, toolCallCount, finalText };
      }

      for (const tc of toolCalls) {
        if (tc.type !== "function") continue;
        toolCallCount += 1;
        let args: Record<string, unknown> = {};
        try {
          args = tc.function.arguments ? JSON.parse(tc.function.arguments) : {};
        } catch (err) {
          logger.warn({ err, raw: tc.function.arguments }, "openai tool args JSON parse failed");
        }
        const toolCall: ToolCall = { name: tc.function.name, args };
        let result: unknown;
        try {
          result = await opts.onToolCall(toolCall);
        } catch (err) {
          result = { error: err instanceof Error ? err.message : "tool threw" };
        }
        history.push({
          role: "tool",
          tool_call_id: tc.id,
          content: JSON.stringify(result ?? {}),
        } as ChatCompletionMessageParam);
        // finish_turn signals end of turn — break immediately so the loop
        // doesn't make another model call after the reply is already set.
        if (toolCall.name === "finish_turn") {
          finished = true;
          break;
        }
      }
    }

    if (finished) {
      return { completedNaturally: true, toolCallCount, finalText };
    }

    logger.warn({ maxIterations: opts.maxIterations }, "openai agent loop hit iteration cap");
    return { completedNaturally: false, toolCallCount, finalText };
  },
};
