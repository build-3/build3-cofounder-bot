# Conversational Quality — Batch B

**Date:** 2026-04-21
**Status:** Draft — awaiting user review
**Depends on:** Batch A (rerank_v3 + voice_v3, merged)
**Scope:** Three structural changes that move the bot from "one candidate, one button-pair, one outbound" to "a thoughtful operator presenting up to two options, honestly, including a no."

## Why

Batch A fixed the *voice*. What's left is the *rhythm*:
- Boardy often surfaces **two candidates at once** (Anuj + Shubham, Abhishek + Pranav). One-at-a-time feels like a slot machine; two-at-a-time feels like a curator.
- Boardy says **"I don't feel comfortable intro'ing this one right now because…"** out loud (Santhosh, Manoj, Abhishek Prasad). A bot that only proposes is a bot without judgment.
- Boardy handles **topic switches** cleanly ("actually forget the cofounder, find me investors"). Our current router silently turns that into a `refine` and corrupts `search_state`.

Each of these touches the dispatcher's one-outbound-per-inbound contract or the classifier. They deserve their own spec.

## Goals

1. When the reranker is confident about more than one candidate, show **two** in one reply.
2. When the reranker judges a match is ranked well but shouldn't be intro'd yet, mark it **hold** and render a "here's why I'm holding" card with an override option.
3. When the user switches topic to something the bot can't help with, route to **`topic_switch`** — honestly say so, ask if they want to pause or change the search.

## Non-goals

- Proactive follow-up ("How did it go with Anuj?"). Explicitly deferred.
- More than two candidates per turn.
- A full "advisor" mode (where Boardy gets asked about cold emails or raise strategy and helps). Our off_topic path already handles a polite steer-back; expanding it is out of scope.

## Changes

### B1 — Two candidates per turn when confidence is high

**Files:** [src/wati/dispatcher.ts](src/wati/dispatcher.ts), [src/matching/pipeline.ts](src/matching/pipeline.ts)

**Current invariant (Batch A):** `runAndReply` takes `cards[0]`, records it shown, sends one `sendButtons` with Accept/Skip, writes one outbound turn.

**New invariant:** `runAndReply` takes up to `N = 2` cards and sends them as **one outbound message** — still one `sendButtons` call, still one outbound turn, still one idempotency unit. This preserves the "exactly one outbound per inbound" contract that the dispatch lock in [src/wati/dispatcher.ts:107](src/wati/dispatcher.ts:107) is built around.

**Confidence rule:** show two cards only when the reranker returned at least two candidates AND `score[1] >= 0.6 * score[0]`. Otherwise show one. This stops us from padding a weak second candidate next to a strong first one — Boardy does the same (sometimes one, sometimes two).

**Rendered shape:**

```
Here are two worth looking at:

1) *Anuj Rathi* — Bangalore
• ex Swiggy / Cleartrip growth, scaled marketplaces at real scale
• building an AI matchmaking product — he gets what you're doing
Potential drawback: hunting a technical cofounder himself, so this may be a notes-swap.

2) *Shubham Shah* — Bangalore
• CTO office at Varaha (climate), built a 20k-ticket community platform
• 0-to-1 B2B marketplace reps — not allergic to messy early stage
Potential drawback: reads more operator than CEO — test fundraising appetite early.

Reply *1* or *2* to pick one, *Skip* to see others.
```

**Button model:** WATI interactive-buttons caps at 3 buttons. With two candidates we go to typed replies: "1", "2", "Skip". Buttons still used when there's a single card (Accept / Skip) — unchanged flow. The intent classifier in `voice.ts` needs `\b1\b` / `\b2\b` heuristics that resolve to "pick the Nth shown candidate". Deterministic-first per CLAUDE.md rule #6.

**Record shown:** `recordShown` already accepts an array. We pass both cards. The dispatcher's duplicate-race guard (the `recorded === false` path) already treats the whole insert as a unit.

**Accept path change:** `onAccept` currently calls `getLastShownFounderId`. It becomes `getLastShownFounderIds` (plural) returning the two most recent `shown` rows for this conversation in rank order. If the user said "1" we propose the first; "2", the second. Typed "accept" with no number falls back to the single-most-recent (= position 1) with a warning log — keeps old flow working.

### B2 — `hold` recommendation ("I don't feel comfortable intro'ing this right now because…")

**Files:** [src/llm/prompts/rerank_v4.ts](src/llm/prompts/rerank_v4.ts) (new), [src/matching/reranker.ts](src/matching/reranker.ts), [src/matching/pipeline.ts](src/matching/pipeline.ts), [src/wati/dispatcher.ts](src/wati/dispatcher.ts)

Rerank prompt `rerank_v4` adds one field per candidate:

```json
{
  "intro_recommendation": "warm" | "hold",
  "hold_reason": "<one sentence, grounded, required when hold, else ''>"
}
```

**When the reranker returns `hold`:** we still show the card in the ranked position, but the drawback line becomes the hold reason, and the button/reply hints change:

```
*Santhosh Katkurwar* — Bangalore
• head of Growth + BD with sell-build-fundraise reps
• thinks in GTM systems, operator energy

Holding off on this intro: he explicitly wants funded startups with
real execution budget. You're pre-product — a budget for GTM experiments
would unlock this one.

Reply *Force intro* to override, *Skip* to see others.
```

Single `sendButtons` with one button: `Force intro` (payload `FORCE_INTRO`). Skip stays as a typed fallback.

**Classifier:** add `force_intro` to `VoiceIntent`. Button payload `FORCE_INTRO` is authoritative. Typed "force intro" / "intro anyway" resolves heuristically.

**`onForceIntro` handler:** behaves exactly like `onAccept`, but logs `forced=true` in the `candidates_shown.action` trail (new action value; schema already stores `action` as free text — no migration). Ensures we can measure override rate later.

**Interaction with B1:** if the top card is `hold` and the runner-up is `warm`, we show them as positions 1 and 2 with different button semantics per card. Keep the rendered text honest — position 2 can say "I'd be happier about this one:" as the header.

### B3 — `topic_switch` intent

**Files:** [src/llm/prompts/voice_v3.ts](src/llm/prompts/voice_v3.ts) (add situation + intent to enum), [src/conversation/voice.ts](src/conversation/voice.ts)

**The gap:** classifier currently returns `other` → router maps to `onClarify`, which asks a cofounder-matching follow-up. User said "find me investors", bot said "could you say a bit more about who you're looking for?". Feels broken.

**Fix:** add `topic_switch` to the `VoiceIntent` union and the `INTENT_SYSTEM` prompt. Classifier learns to return it when the user pivots to something out of scope (investors, legal, cold emails, weather not counted — that's `off_topic`). Topic_switch is specifically: user *wants a service* we don't offer.

Add a `topic_switch` situation to voice guidance:

> One honest line that says you only do cofounder matching. Then one question: pause the search, or keep going with a different cofounder ask?

No `search_state` writes on `topic_switch`. Existing state is preserved so if they say "pause, actually keep searching" we haven't lost context.

**Confidence gate:** if classifier returns `topic_switch` below 0.7, treat as `clarify` instead. Stops a hallucinated topic-switch from derailing a genuine refinement.

## Contract changes

This is the core reason Batch B is its own spec:

| Contract | Batch A | Batch B |
|---|---|---|
| Outbounds per inbound | exactly 1 | exactly 1 (still) — multi-card payload is one message |
| Candidates per outbound | exactly 1 | 1 or 2 depending on confidence |
| `candidates_shown` rows per outbound | 1 | 1 or 2 |
| Button set | Accept / Skip | Accept / Skip (1 card, warm) OR 1/2/Skip typed (2 cards) OR Force intro / Skip (hold) |
| Intent union | +`force_intro`, +`topic_switch` | |

The single-outbound invariant is preserved. The dispatch lock and the 15-second duplicate-text guard keep working unchanged.

## Testing

Unit:
- Reranker schema parses v4 responses (warm and hold).
- Reranker schema accepts v3 responses (hold defaults to `warm`, reason to `""`).
- `formatTwoCardsText` (new) snapshot.
- `formatHoldCard` (new) snapshot.
- `classifyIntent` heuristic: "1" and "2" resolve to `pick_n` variant of accept; "force intro" resolves to `force_intro`.
- `classifyIntent` heuristic + LLM: "actually find me investors" → `topic_switch`.
- Confidence gate: `topic_switch` at 0.5 falls back to `clarify`.

Integration (no live LLM):
- Dispatch a refine turn where rerank stub returns two candidates with scores 0.9 and 0.7 → asserts one `sendButtons` with numbered body.
- Dispatch a refine turn where rerank stub returns `hold` for top candidate → asserts single button `Force intro` and "Holding off" language.
- Dispatch a "find me investors" turn → asserts `topic_switch` reply, search_state unchanged.

All existing tests stay green. The idempotency / consent / rate-limit suites don't care about card count.

## Rollout

1. Merge the Batch A PR first (it's already up for review).
2. Merge this spec's PR. A single feature flag `BATCH_B_ENABLED` in config gates the new behavior — default `false`. Old code paths remain exercisable for rollback.
3. Flip the flag on for a small allowlist of conversations (reuse the cohort allowlist, or add a per-founder flag). Watch outbound volume and override rate for 48h.
4. Flip globally.

Rollback: flag off. No migration to undo.

## Doc updates required

- `docs/DECISIONS.md` — ADR-012 for hold + two-at-a-time + topic_switch.
- `docs/MATCHING.md` — new section on hold vs warm, two-candidate rendering.
- `docs/STATE_MACHINE.md` — no change (consent machine unaffected).
- `docs/API_CONTRACTS.md` — no change (webhook unchanged).
- `docs/PROJECT_STATE.md` — Batch B status.

## Open questions for user review

**Q1.** Force intro button label. Alternatives: "Intro anyway", "Reach out regardless", "I'll take it". Current pick: *Force intro* — crisp, honest about the override.

**Q2.** Two-candidate reply format — `1` / `2` typed vs two separate outbound messages (one per card) with Accept/Skip each. I went with single-message-numbered because it preserves the one-outbound invariant and keeps the dispatch lock meaningful. If you want two distinct outbound bubbles, that's a deeper contract change and I'd argue against it.

**Q3.** Feature flag or straight ship? I've written for a flag because the outbound-count change deserves an observation window. If you'd rather ship directly and revert on PR if bad, drop the flag — saves ~40 lines of config plumbing.
