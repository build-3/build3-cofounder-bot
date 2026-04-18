import { describe, expect, it } from "vitest";
import { insertInboundTurn } from "../../src/conversation/store.js";

/**
 * Simulates the postgres tagged-template client for this one query:
 *   INSERT ... ON CONFLICT (wati_message_id) DO NOTHING RETURNING id
 *
 * The real DB enforces the unique index on `wati_message_id`. Here we mimic
 * that behavior with a Set so we can assert the contract that feature code
 * relies on: duplicate wati message ids return `false`.
 */
function fakeSqlWithSeenIds() {
  const seen = new Set<string>();
  const calls: Array<{ watiMessageId: string; inserted: boolean }> = [];

  const sql = ((_strings: TemplateStringsArray, ...values: unknown[]) => {
    // values order from the INSERT in store.ts:
    //   conversationId, watiMessageId, text, intent
    const watiMessageId = values[1] as string;
    const inserted = !seen.has(watiMessageId);
    if (inserted) seen.add(watiMessageId);
    calls.push({ watiMessageId, inserted });
    return Promise.resolve(inserted ? [{ id: `turn-${seen.size}` }] : []);
  }) as unknown as Parameters<typeof insertInboundTurn>[1];

  return { sql, calls, seen };
}

describe("insertInboundTurn (idempotency contract)", () => {
  it("returns true on first insert with a given watiMessageId", async () => {
    const { sql } = fakeSqlWithSeenIds();
    const ok = await insertInboundTurn(
      { conversationId: "c1", watiMessageId: "wati-1", text: "hi" },
      sql,
    );
    expect(ok).toBe(true);
  });

  it("returns false when the same watiMessageId is inserted twice", async () => {
    const { sql } = fakeSqlWithSeenIds();
    const first = await insertInboundTurn(
      { conversationId: "c1", watiMessageId: "wati-1", text: "hi" },
      sql,
    );
    const second = await insertInboundTurn(
      { conversationId: "c1", watiMessageId: "wati-1", text: "hi again" },
      sql,
    );
    expect(first).toBe(true);
    expect(second).toBe(false);
  });

  it("treats distinct watiMessageIds independently", async () => {
    const { sql } = fakeSqlWithSeenIds();
    const a = await insertInboundTurn(
      { conversationId: "c1", watiMessageId: "wati-a", text: "x" },
      sql,
    );
    const b = await insertInboundTurn(
      { conversationId: "c1", watiMessageId: "wati-b", text: "y" },
      sql,
    );
    expect(a).toBe(true);
    expect(b).toBe(true);
  });
});
