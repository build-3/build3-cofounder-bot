import "dotenv/config";
import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.string().default("info"),

  DATABASE_URL: z.string().min(1),

  OPENAI_API_KEY: z.string().min(1).optional(),
  // Rerank uses a smaller model — structured-JSON over 5 candidates fits in a
  // 1.5K-token output budget and gpt-4.1-mini comes back in ~3-4s vs ~10s+
  // for full gpt-4.1, with no observable rerank-quality regression on our
  // golden set. The agent loop stays on the larger model where conversational
  // nuance pays off.
  OPENAI_MODEL_RERANK: z.string().default("gpt-4.1-mini"),
  OPENAI_MODEL_CHAT: z.string().default("gpt-4.1"),
  OPENAI_MODEL_EMBED: z.string().default("text-embedding-3-small"),

  GOOGLE_AI_KEY: z.string().min(1).optional(),
  GEMINI_MODEL_CHAT: z.string().default("gemini-2.5-flash"),
  // Agent loop default is flash — orchestrating 5 well-defined tool calls
  // does not need pro-tier reasoning, and pro adds 2-3s of latency per turn
  // which compounds across the agent's typical 2-iteration cycle. Override
  // to gemini-2.5-pro via env if quality regresses for a specific cohort.
  GEMINI_MODEL_AGENT: z.string().default("gemini-2.5-flash"),
  // Rerank can run on flash-lite — same JSON-mode call, much cheaper and faster.
  GEMINI_MODEL_RERANK: z.string().default("gemini-2.5-flash-lite"),
  GEMINI_MODEL_EMBED: z.string().default("gemini-embedding-001"),

  LLM_PROVIDER: z.enum(["openai", "gemini"]).default("gemini"),

  WATI_API_BASE_URL: z.string().url(),
  WATI_API_TOKEN: z.string().min(1),
  WATI_WEBHOOK_SECRET: z.string().min(8),
  WATI_REOPEN_TEMPLATE: z.string().default("cofounder_reopen_v1"),

  ADMIN_TOKEN: z.string().min(8),
  CONSENT_EXPIRY_HOURS: z.coerce.number().int().positive().default(72),

  // Safety rails — see src/wati/rate-limit.ts
  KILL_SWITCH: z.coerce.boolean().default(false),
  OUTBOUND_MAX_PER_WINDOW: z.coerce.number().int().positive().default(3),
  OUTBOUND_WINDOW_SECONDS: z.coerce.number().int().positive().default(60),
}).superRefine((value, ctx) => {
  if (value.LLM_PROVIDER === "openai" && !value.OPENAI_API_KEY) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["OPENAI_API_KEY"],
      message: "required when LLM_PROVIDER=openai",
    });
  }
  if (value.LLM_PROVIDER === "gemini" && !value.GOOGLE_AI_KEY) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["GOOGLE_AI_KEY"],
      message: "required when LLM_PROVIDER=gemini",
    });
  }
});

export type AppConfig = z.infer<typeof schema>;

let cached: AppConfig | null = null;

export function loadConfig(): AppConfig {
  if (cached) return cached;
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("\n  ");
    throw new Error(`Invalid environment configuration:\n  ${issues}`);
  }
  cached = parsed.data;
  return cached;
}
