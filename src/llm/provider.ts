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

export interface LLMProvider {
  readonly name: "openai" | "gemini";

  /** Plain chat completion returning string content. */
  chat(messages: LLMMessage[], opts?: { temperature?: number; maxTokens?: number }): Promise<string>;

  /** JSON-mode call. Implementations MUST request strict JSON and hand the raw string to `parse`. */
  json<T>(opts: JsonCallOptions<T>): Promise<T>;

  /** Batched embeddings. Returns one vector per input, same order. */
  embed(inputs: string[], opts?: EmbedOptions): Promise<number[][]>;
}
