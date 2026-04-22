/**
 * Provider-agnostic LLM interface. MVP uses OpenAI; Gemini adapter stub exists
 * so we can swap without touching call sites. All callers program against this
 * interface — no direct SDK imports in feature code.
 */
export interface LLMMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface JsonCallOptions<T> {
  system: string;
  user: string;
  schemaName: string;
  parse: (raw: string) => T;
  temperature?: number;
  maxTokens?: number;
}

export interface EmbedOptions {
  taskType?: "RETRIEVAL_QUERY" | "RETRIEVAL_DOCUMENT";
}

/** Parameters schema for a tool, expressed as a JSON Schema subset.
 *
 *  OpenAI rejects arrays without `items` (400 invalid_function_parameters).
 *  Gemini is more forgiving but the shape is still ambiguous, so every array
 *  property MUST declare `items`. For primitive arrays use `{ type: "string" }`;
 *  for object arrays declare the nested shape so strict validators accept it.
 */
export type ToolPrimitiveItem = { type: "string" | "number" | "boolean" };

export type ToolObjectItem = {
  type: "object";
  properties: Record<string, ToolPrimitiveItem & { description?: string }>;
  required?: string[];
};

export interface ToolParameterSchema {
  type: "object";
  properties: Record<string, {
    type: "string" | "number" | "boolean" | "array" | "object";
    description?: string;
    items?: ToolPrimitiveItem | ToolObjectItem;
    enum?: string[];
  }>;
  required?: string[];
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: ToolParameterSchema;
}

export interface ToolCall {
  name: string;
  args: Record<string, unknown>;
}

export interface AgentLoopOptions {
  system: string;
  messages: LLMMessage[];
  tools: ToolDefinition[];
  /** Callback the provider invokes when the model requests a tool. Must
   *  return the tool's JSON-serialisable result, which is fed back as the
   *  next model turn. */
  onToolCall: (call: ToolCall) => Promise<unknown>;
  /** Hard cap on tool iterations. Provider MUST stop after this many and
   *  return whatever it has. */
  maxIterations: number;
  temperature?: number;
  model?: string;
}

export interface AgentLoopResult {
  /** True if the loop terminated because the model stopped calling tools
   *  (natural completion). False if we hit maxIterations. */
  completedNaturally: boolean;
  /** Total tool calls executed. */
  toolCallCount: number;
  /** The final text output the model produced (may be empty if the model
   *  only emitted tool calls). Agent code uses the `finish_turn` tool
   *  call's args for the user-facing reply, not this field. */
  finalText: string;
}

export interface LLMProvider {
  readonly name: "openai" | "gemini";

  /** Plain chat completion returning string content. */
  chat(messages: LLMMessage[], opts?: { temperature?: number; maxTokens?: number }): Promise<string>;

  /** JSON-mode call. Implementations MUST request strict JSON and hand the raw string to `parse`. */
  json<T>(opts: JsonCallOptions<T>): Promise<T>;

  /** Batched embeddings. Returns one vector per input, same order. */
  embed(inputs: string[], opts?: EmbedOptions): Promise<number[][]>;

  /** Run a function-calling agent loop. Provider orchestrates
   *  model→tool→model turns, calling `onToolCall` for each request,
   *  until the model stops calling tools or `maxIterations` is hit. */
  agentLoop(opts: AgentLoopOptions): Promise<AgentLoopResult>;
}
