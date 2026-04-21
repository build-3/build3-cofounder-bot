import { logger } from "../lib/logger.js";
import { loadConfig } from "../lib/config.js";

/**
 * Per-waId outbound rate limiter. Enforces an upper bound on outbound messages
 * to any single WhatsApp number in a sliding window. Prevents the kind of
 * 50-message flood that triggered the emergency kill switch.
 *
 * Implementation: in-process Map<waId, timestamps[]>. Good enough for a single
 * serverless instance; on Vercel each invocation may start cold, so the limiter
 * is a last-line defense, not the primary correctness mechanism (one reply per
 * inbound + DB-level idempotency are the primary ones).
 */

const hits = new Map<string, number[]>();

export interface RateLimitDecision {
  allowed: boolean;
  remaining: number;
  resetInMs: number;
}

export interface RateLimitOverrides {
  maxPerWindow?: number;
  windowSeconds?: number;
}

export function checkOutboundRate(
  waId: string,
  now: number = Date.now(),
  overrides?: RateLimitOverrides,
): RateLimitDecision {
  let windowMs: number;
  let max: number;
  if (overrides?.maxPerWindow !== undefined && overrides.windowSeconds !== undefined) {
    max = overrides.maxPerWindow;
    windowMs = overrides.windowSeconds * 1000;
  } else {
    const cfg = loadConfig();
    windowMs = cfg.OUTBOUND_WINDOW_SECONDS * 1000;
    max = cfg.OUTBOUND_MAX_PER_WINDOW;
  }

  const existing = hits.get(waId) ?? [];
  const fresh = existing.filter((t) => now - t < windowMs);

  if (fresh.length >= max) {
    const oldest = fresh[0]!;
    return {
      allowed: false,
      remaining: 0,
      resetInMs: windowMs - (now - oldest),
    };
  }

  fresh.push(now);
  hits.set(waId, fresh);
  return { allowed: true, remaining: max - fresh.length, resetInMs: windowMs };
}

export function __resetRateLimitForTests(): void {
  hits.clear();
}

export class RateLimitExceededError extends Error {
  readonly waId: string;
  readonly resetInMs: number;
  constructor(waId: string, resetInMs: number) {
    super(`outbound rate limit exceeded for ${waId} (resets in ${resetInMs}ms)`);
    this.waId = waId;
    this.resetInMs = resetInMs;
    this.name = "RateLimitExceededError";
  }
}

export function assertOutboundAllowed(waId: string): void {
  const d = checkOutboundRate(waId);
  if (!d.allowed) {
    logger.warn({ waId, resetInMs: d.resetInMs }, "outbound rate limit hit — dropping send");
    throw new RateLimitExceededError(waId, d.resetInMs);
  }
}
