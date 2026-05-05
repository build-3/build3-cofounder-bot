import { describe, expect, it } from "vitest";
import { TelegramUpdateSchema } from "../../src/telegram/types.js";

describe("TelegramUpdateSchema", () => {
  it("parses a regular text-message update", () => {
    const parsed = TelegramUpdateSchema.safeParse({
      update_id: 100001,
      message: {
        message_id: 42,
        date: 1777970000,
        chat: { id: 12345, type: "private", username: "based_god" },
        from: { id: 12345, is_bot: false, first_name: "Arjun", username: "based_god" },
        text: "hello",
      },
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.update_id).toBe(100001);
      expect(parsed.data.message?.text).toBe("hello");
      expect(parsed.data.message?.from?.username).toBe("based_god");
    }
  });

  it("parses an inline-button callback_query update", () => {
    const parsed = TelegramUpdateSchema.safeParse({
      update_id: 100002,
      callback_query: {
        id: "cb-abc",
        from: { id: 12345, is_bot: false, username: "based_god" },
        data: "accept",
        message: {
          message_id: 43,
          date: 1777970005,
          chat: { id: 12345, type: "private" },
        },
      },
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.callback_query?.data).toBe("accept");
    }
  });

  it("accepts updates with extra fields via passthrough (forward-compat)", () => {
    const parsed = TelegramUpdateSchema.safeParse({
      update_id: 100003,
      edited_message: { message_id: 99, date: 1, chat: { id: 1, type: "private" } },
      // edited_message is ignored downstream — schema must still accept it.
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects updates missing update_id", () => {
    const parsed = TelegramUpdateSchema.safeParse({ message: { text: "hi" } });
    expect(parsed.success).toBe(false);
  });

  it("rejects non-integer update_id", () => {
    const parsed = TelegramUpdateSchema.safeParse({ update_id: "abc" });
    expect(parsed.success).toBe(false);
  });
});
