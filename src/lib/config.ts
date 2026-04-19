import "dotenv/config";
import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.string().default("info"),

  DATABASE_URL: z.string().min(1),

  OPENAI_API_KEY: z.string().min(1),
  OPENAI_MODEL_RERANK: z.string().default("gpt-4.1"),
  OPENAI_MODEL_CHAT: z.string().default("gpt-4.1"),
  OPENAI_MODEL_EMBED: z.string().default("text-embedding-3-small"),

  LLM_PROVIDER: z.enum(["openai", "gemini"]).default("openai"),

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
