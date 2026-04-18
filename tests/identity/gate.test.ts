import { describe, expect, it } from "vitest";
import { normalizePhone } from "../../src/identity/gate.js";

describe("normalizePhone", () => {
  it("strips leading +", () => {
    expect(normalizePhone("+919876543210")).toBe("919876543210");
  });
  it("strips leading 00", () => {
    expect(normalizePhone("0091 98765 43210")).toBe("919876543210");
  });
  it("strips spaces, dashes, parens", () => {
    expect(normalizePhone("+91 (987) 654-3210")).toBe("919876543210");
  });
  it("is idempotent", () => {
    expect(normalizePhone(normalizePhone("+919876543210"))).toBe("919876543210");
  });
  it("leaves a clean E.164-without-plus untouched", () => {
    expect(normalizePhone("919876543210")).toBe("919876543210");
  });
});
