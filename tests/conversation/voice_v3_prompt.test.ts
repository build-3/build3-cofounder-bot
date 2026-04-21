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

  it("greeting prompt is the two-beat 'how I match / sharpening question' shape", () => {
    const user = buildVoiceUser(makeCtx({ situation: "greeting" }));
    expect(user).toContain("SITUATION: greeting");
    // Beat 1 — how we match.
    expect(user).toMatch(/complementary\s+skills/i);
    expect(user).toMatch(/not keyword overlap/i);
    // Beat 2 — sharpening question.
    expect(user).toMatch(/one crisp sharpening question/i);
    // Explicit bans.
    expect(user).toMatch(/do NOT list role examples/i);
    expect(user).toMatch(/do NOT say 'separated by commas'/i);
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
});
