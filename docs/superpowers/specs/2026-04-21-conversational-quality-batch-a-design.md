# Conversational Quality — Batch A

**Date:** 2026-04-21
**Status:** Draft — awaiting user review
**Scope:** Prompt + format changes only. No DB migrations, no new routes, no contract changes to the dispatcher's "one outbound per inbound" invariant.

## Why

The bot currently reads as a matcher wrapped in a menu. Boardy reads as a thoughtful operator. The delta is not architectural — it's posture: card shape, first-turn framing, and the tone of gate rejections. Fix those and the bot feels like a different product, with near-zero rollout risk.

Batch B (qualified-no, 2-at-a-time fanout, topic-switch intent) is explicitly deferred — those change the dispatcher contract and deserve their own spec.

## Goals

1. The candidate card reads like an operator's note, not a profile dump.
2. The first turn explains *how* the bot matches before asking what they want.
3. The non-cohort rejection feels warm and useful, not robotic.
4. A runbook exists for disabling the WATI dashboard flows that currently intercept messages.

## Non-goals (Batch B)

- Multiple candidates per turn
- "Hold" / qualified-no recommendation state
- `topic_switch` intent label
- Proactive follow-up jobs

## Changes

### 1. Card shape — bullet-prose with grounded drawback

**File:** [src/matching/pipeline.ts](src/matching/pipeline.ts), [src/llm/prompts/rerank_v3.ts](src/llm/prompts/rerank_v3.ts) (new)

Today's card (from `formatCardText`):

```
Closest fit right now

*Anuj Rathi* — Bangalore
Ex Swiggy / Cleartrip growth leader
Founder-level · 12 yrs · Pre-seed · B2B SaaS / AI infra

_Why this could work:_ shared B2B SaaS focus, strong growth background.

Reply *Accept* to connect, *Skip* to see the next.
```

New card:

```
*Anuj Rathi* — Bangalore

• Ex Swiggy / Cleartrip growth leader, scaled marketplaces at real scale
• Building an AI matchmaking product — he actually "gets" what you're doing
• In my network, warm intro available

Potential drawback: he's hunting a technical cofounder himself and plans to raise fast, so this may turn into a notes-swap rather than him joining you.

Reply *Accept* to connect, *Skip* to see the next.
```

**How:**
- Bump reranker prompt to `rerank_v3`. New response shape adds two string fields: `bullets: string[]` (2–3 items, each a single line, grounded in the candidate's `headline`/`summary`/tags — no invention) and `drawback: string` (one sentence, also grounded, naming a specific reason the match could fail). The existing `rationale` field is dropped; nothing consumes it after this change.
- `formatCardText(card)` drops the structured meta line and the italic "Why this could work" line. Signature becomes `formatCardText(card: CandidateCard): string` — the `index`/`total` params are dead (we only ever show one card per turn) and get removed.
- The rerank call site in the pipeline stores `bullets` and `drawback` on `CandidateCard` and on the `candidates_shown` row (replacing the existing `rationale` column usage — we repurpose it as a JSON blob with both fields, no schema change).

**Grounding guardrail:** The prompt explicitly forbids inventing facts. Bullets and drawback must only restate or compress information present in the candidate payload. If the model has nothing honest to say for a drawback, it returns an empty string and the card omits the line.

**Prompt versioning:** Per CLAUDE.md rule #3, `rerank_v2.ts` stays on disk. `src/llm/rerank.ts` imports from `rerank_v3.ts`. ADR entry in `docs/DECISIONS.md` records the bump.

### 2. First-turn "how I match" framing

**File:** [src/llm/prompts/voice_v3.ts](src/llm/prompts/voice_v3.ts) (new)

The `greeting` situation guidance changes from "introduce yourself briefly, then ask who they're looking to meet" to a two-beat:

> Beat 1: one line explaining how you match — you optimize for complementary skills, shared stage, and values fit, not keyword overlap.
> Beat 2: one crisp sharpening question — what's the one thing this person must be great at, and what do you refuse to do yourself?

Still under 220 chars total. Hard rule: no lists, no bullets, no "Examples: engineering, product, marketing" menu vomit. If Gemini produces a list, we regenerate once; on second failure we fall back to a hardcoded two-sentence version in voice.ts (per CLAUDE.md rule #7 — every LLM call has a fallback).

### 3. Warm non-cohort rejection

**File:** [src/llm/prompts/voice_v3.ts](src/llm/prompts/voice_v3.ts)

`non_cohort` situation guidance rewrite. Current output: flat "Hey! This bot is just for the Build3 cohort founders. For anything else, best to reach out to the Build3 team directly."

New shape (one short WhatsApp message, not two bubbles):

> Hey — I'm the matching bot for the Build3 founder cohort, so I can't help directly. If you're a cohort founder getting this by mistake, ping the Build3 team and they'll sort it. Otherwise: build3.com.

The URL and "ping the Build3 team" phrasing are templated — no LLM invention. The prompt receives them as CONTEXT data so the model weaves them in naturally rather than inventing different wording each time.

### 4. WATI dashboard runbook

**File:** [docs/WATI_CONFIG.md](docs/WATI_CONFIG.md) (new)

Step-by-step for disabling the WATI flows that intercepted the screenshot conversation:

1. WATI dashboard → Automation → disable any "Welcome Message" flow
2. WATI dashboard → Chatbot → disable the keyword-triggered flow that asks "What skills are you looking for"
3. WATI dashboard → Settings → Default Assignee → disable auto-reply ("Thank you for the message and welcome to our WhatsApp account")
4. Verify: send a test message from a non-cohort number, expect exactly ONE reply — the bot's warm non-cohort message, nothing else

Also documents the **webhook subscription contract** from [CLAUDE.md](CLAUDE.md): only `Message Received` and `Interactive Message Reply` are enabled. If a teammate re-enables `Message Status` or template-trigger events, the bot will double-send.

Linked from `CLAUDE.md` under "WATI wiring".

## What stays the same

- Dispatcher contract: exactly one outbound per inbound.
- Intent classifier (`voice.ts` — still v2 for intents; only the voice-compose prompts bump).
- Consent state machine.
- Idempotency on `wati_message_id`.
- Search state / refinement extraction.
- One candidate per turn (Batch B changes this).

## Testing

- Snapshot test for `formatCardText` with a fixture `CandidateCard` — confirms new bullet-prose shape.
- Snapshot test for the greeting reply with a fixture context — confirms no list / no menu phrasing (regex assertion: no `\n-\s` or `\n\d\.\s` patterns, no "Examples:" literal).
- Snapshot test for `non_cohort` reply — confirms Build3 URL and contact phrasing appear.
- All existing consent/idempotency/dispatcher tests must stay green — no contract changes touch them.

## Rollout

1. Merge → deploys to Vercel automatically (see `docs/DEPLOY.md`).
2. Flip WATI dashboard toggles per runbook.
3. Smoke test with one cohort number + one non-cohort number.
4. If the bullet-prose card reads badly in practice (e.g. Gemini's bullets sound hallucinated), revert the single rerank.ts import line back to `rerank_v2` — no DB rollback needed.

## Doc updates required by CLAUDE.md

- `docs/DECISIONS.md` — ADR for the card-shape change and the prompt bumps.
- `docs/MATCHING.md` — update the "card format" section.
- `docs/API_CONTRACTS.md` — no change (webhook payloads unchanged).
- `docs/STATE_MACHINE.md` — no change.
- `docs/PROJECT_STATE.md` — mark Batch A complete, Batch B queued.

## Open questions

None — Q2 (follow-up job) explicitly deferred by user. Q1 (split) confirmed.
