import pino from "pino";
import { loadConfig } from "./config.js";

const cfg = (() => {
  try {
    return loadConfig();
  } catch {
    return { NODE_ENV: "development", LOG_LEVEL: "info" } as const;
  }
})();

export const logger = pino({
  level: cfg.LOG_LEVEL,
  transport:
    cfg.NODE_ENV === "development"
      ? { target: "pino-pretty", options: { colorize: true, translateTime: "SYS:HH:MM:ss.l" } }
      : undefined,
  redact: {
    paths: ["req.headers.authorization", "req.headers['x-webhook-secret']", "*.OPENAI_API_KEY", "*.WATI_API_TOKEN"],
    censor: "[redacted]",
  },
});
