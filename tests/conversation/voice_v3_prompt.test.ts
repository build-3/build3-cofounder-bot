import { describe, expect, it } from "vitest";
import {
  VOICE_SYSTEM,
  buildVoiceUser,
  type VoiceContext,
} from "../../src/llm/prompts/voice_v3.js";

function makeCtx(overrides: Partial<VoiceContext> = {}): VoiceContext {
  return {
    situation: "greeting",
    founderFirstName: "Shashwat",
    recentTurns: [],
    ...overrides,
  };
}

describe("voice_v3 prompt shape", () => {
  it("VOICE_SYSTEM bans numbered/bulleted menus and 'Examples:' phrasing", () => {
    expect(VOICE_SYSTEM).toMatch(/never present options as a numbered list/i);
    expect(VOICE_SYSTEM).toMatch(/never use the phrase "examples:"/i);
    expect(VOICE_SYSTEM).toMatch(/separated by commas/i);
    // The ban text itself mentions these — it's telling the model NOT to
    // produce them. The assertions above are on the ban sentences.
  });

  it("greeting prompt hands Gemini context and lets it decide (no hard script)", () => {
    const user = buildVoiceUser(makeCtx({ situation: "greeting" }));
    expect(user).toContain("SITUATION: greeting");
    // Must point Gemini at the two sources of truth it reads.
    expect(user).toMatch(/RECENT_TURNS/);
    expect(user).toMatch(/SEARCH_STATE/);
    // Form-filler bans still apply so the opener never turns into a menu.
    expect(user).toMatch(/no role-word menus/i);
    // Anti-repeat rule in the per-situation guidance.
    expect(user).toMatch(/never ask a question the user already answered/i);
  });

  it("non_cohort prompt asks for a warm single message with the Build3 escape hatch", () => {
    const user = buildVoiceUser(makeCtx({ situation: "non_cohort" }));
    expect(user).toContain("SITUATION: non_cohort");
    expect(user).toMatch(/build3 founder\s*cohort/i);
    expect(user).toMatch(/ping the Build3 team/i);
    expect(user).toMatch(/build3\.com/i);
  });

  it("unchanged situations still route through v3's builder (smoke)", () => {
    const user = buildVoiceUser(makeCtx({ situation: "skip_ack" }));
    expect(user).toContain("SITUATION: skip_ack");
    expect(user).toMatch(/short natural ack after a skip/i);
  });

  it("topic_switch guidance is honest about scope and offers a pause/redirect", () => {
    const user = buildVoiceUser(makeCtx({ situation: "topic_switch" }));
    expect(user).toContain("SITUATION: topic_switch");
    expect(user).toMatch(/only do cofounder matching/i);
    expect(user).toMatch(/pause|redirect|different cofounder ask/i);
    expect(user).toMatch(/do not pretend/i);
  });
});
