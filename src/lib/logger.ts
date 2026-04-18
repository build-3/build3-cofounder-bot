import pino from "pino";
import { loadConfig } from "./config.js";

const cfg = (() => {
  try {
    return loadConfig();
  } catch {
    return { NODE_ENV: "development", LOG_LEVEL: "info" } as const;
  }
})();

const pinoOptions: pino.LoggerOptions = {
  level: cfg.LOG_LEVEL,
  redact: {
    paths: [
      "req.headers.authorization",
      "req.headers['x-webhook-secret']",
      "*.OPENAI_API_KEY",
      "*.WATI_API_TOKEN",
    ],
    censor: "[redacted]",
  },
};

if (cfg.NODE_ENV === "development") {
  pinoOptions.transport = {
    target: "pino-pretty",
    options: { colorize: true, translateTime: "SYS:HH:MM:ss.l" },
  };
}

export const logger = pino(pinoOptions);
