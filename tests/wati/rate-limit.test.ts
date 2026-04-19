import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  __resetRateLimitForTests,
  checkOutboundRate,
} from "../../src/wati/rate-limit.js";

/**
 * Safety-rail tests for the per-waId outbound rate limiter. The limiter
 * exists specifically to prevent a 50-message flood to one founder like
 * the one that triggered the 2026-04-19 kill switch.
 */
const LIMITS = { maxPerWindow: 3, windowSeconds: 60 };

describe("checkOutboundRate", () => {
  beforeEach(() => __resetRateLimitForTests());
  afterEach(() => __resetRateLimitForTests());

  it("allows the first N sends in the window", () => {
    const now = 1_700_000_000_000;
    expect(checkOutboundRate("911111111111", now, LIMITS).allowed).toBe(true);
    expect(checkOutboundRate("911111111111", now + 100, LIMITS).allowed).toBe(true);
    expect(checkOutboundRate("911111111111", now + 200, LIMITS).allowed).toBe(true);
  });

  it("blocks the 4th send within the window", () => {
    const now = 1_700_000_000_000;
    checkOutboundRate("911111111111", now, LIMITS);
    checkOutboundRate("911111111111", now + 100, LIMITS);
    checkOutboundRate("911111111111", now + 200, LIMITS);
    const fourth = checkOutboundRate("911111111111", now + 300, LIMITS);
    expect(fourth.allowed).toBe(false);
    expect(fourth.resetInMs).toBeGreaterThan(0);
  });

  it("lets the counter roll off after the window passes", () => {
    const now = 1_700_000_000_000;
    checkOutboundRate("911111111111", now, LIMITS);
    checkOutboundRate("911111111111", now + 100, LIMITS);
    checkOutboundRate("911111111111", now + 200, LIMITS);
    expect(checkOutboundRate("911111111111", now + 61_000, LIMITS).allowed).toBe(true);
  });

  it("tracks waIds independently", () => {
    const now = 1_700_000_000_000;
    checkOutboundRate("911111111111", now, LIMITS);
    checkOutboundRate("911111111111", now + 100, LIMITS);
    checkOutboundRate("911111111111", now + 200, LIMITS);
    expect(checkOutboundRate("911111111111", now + 300, LIMITS).allowed).toBe(false);
    expect(checkOutboundRate("912222222222", now + 300, LIMITS).allowed).toBe(true);
  });
});
