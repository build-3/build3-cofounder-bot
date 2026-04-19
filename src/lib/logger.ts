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

// Pretty-printing is intentionally *not* wired here. On serverless runtimes
// (Vercel/Lambda), `pino-pretty`'s worker-thread transport can't resolve its
// own module path and crashes at module init (`unable to determine transport
// target`). We keep pino bare here and let the local-dev entrypoint pipe
// stdout through `pino-pretty` via a CLI (e.g. `npm run dev | pino-pretty`)
// if human-readable logs are needed locally.

export const logger = pino(pinoOptions);
