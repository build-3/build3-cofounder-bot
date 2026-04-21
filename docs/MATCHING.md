# Matching Pipeline

Three layers, deterministic-first where possible, LLM only where judgment is required.

---

## Layer 1 — Retrieval (deterministic, fast)

**Goal**: get ~50 plausible candidates in <200ms.

Steps:
1. Build a **query string** from `search_state` + the latest user turn.
2. Embed the query with `text-embedding-3-small`.
3. `pgvector` ANN over `founder_embeddings` (cosine, k=50).
4. Apply **hard filters** from `search_state.must_have` and `search_state.location` (if specified).
5. Apply a **keyword boost** for any exact sector/role tag matches.

The requester is always excluded. Already-accepted/skipped candidates in the current conversation are excluded.

---

## Layer 2 — Rerank (LLM, rubric-based)

**Goal**: turn 15 plausible candidates into 3 great ones with a one-line "why" each.

- Model: active provider chat model (`GEMINI_MODEL_CHAT` by default, `OPENAI_MODEL_CHAT` when `LLM_PROVIDER=openai`), temperature 0.2.
- Prompt: `src/llm/prompts/rerank_v4.ts`.
- Rubric (each scored 0–3, summed):
  - Role fit
  - Reciprocal fit (does this founder appear to want the kind of counterpart the requester described?)
  - Sector fit
  - Stage fit
  - Location preference
  - Anti-pref avoidance (negative)
- Output: strict JSON `[{ founder_id, score, rationale, bullets, drawback }]`, validated via Zod. On parse failure: retry once; then fall back to retrieval order with a derived rationale and headline-based bullets.
  - `rationale` — one short sentence, re-used as the requester's note to the target when they accept.
  - `bullets` — 2–3 operator-voice one-liners that render as the card body. Grounded in the candidate payload; empty array is a valid fallback and the card renders from `rationale` instead.
  - `drawback` — one honest "this could fail because…" sentence. Empty string means the card omits the line.

Top 3 are returned. The top 1 is shown first; 2–3 are held for the next Skip.

### Card shape (rerank_v3 + formatCardText)

Rendered in [`src/matching/pipeline.ts`](../src/matching/pipeline.ts) by `formatCardText`:

```
*Name* — City

• bullet one
• bullet two
• bullet three

Potential drawback: <one grounded sentence>

Reply *Accept* to connect, *Skip* to see the next.
```

No "Closest fit right now" header, no seniority/years/stage meta line. Bullets come from the reranker and are not persisted across turns — only `rationale` is stored on `candidates_shown` so the consent flow can re-use it as the requester's note.

---

## Layer 3 — Refinement memory

Every inbound user turn runs `RefinementExtractor`:

- Model: active provider chat model (`GEMINI_MODEL_CHAT` by default, `OPENAI_MODEL_CHAT` when `LLM_PROVIDER=openai`), temperature 0.
- Prompt: `src/llm/prompts/refinement_v3.ts`.
- Input: current `search_state` + last user message.
- Output: `RefinementDelta` (see `API_CONTRACTS.md`).
- Merge rule: `add` overrides scalars and unions lists; `remove` subtracts; `anti_prefs` appends.

On JSON parse failure twice: fall back to a state-aware heuristic extractor. The fallback does two important things:
- Detects fresh asks and clears stale filters so an old `d2c` preference does not leak into a new `fintech` search.
- Captures reciprocal free-text constraints like "I have marketing skills, need a technical cofounder" as `must_have` hints.

Never block the conversation.

---

## Layer 4 — Feedback loop

- **Accept** → freeze candidate, move conversation into `proposed` state (see `STATE_MACHINE.md`). Strong positive signal (not yet used in rerank beyond the current conv; future work).
- **Skip** → append a decayed anti-preference to `search_state.anti_prefs`. Decay = 0.5 per subsequent turn so early skips don't over-suppress later. Cap influence at ~20% of rerank score.

---

## Field weights (initial)

Defined in `src/matching/weights.ts`. Weights are applied to the **query assembly**, not directly to the score — embeddings handle semantic similarity, weights decide which fields enter the query string with what prominence.

| Field           | Weight | Notes |
|-----------------|--------|-------|
| role_tags       | 0.35   | Most decisive: "sales" vs "tech" vs "growth". |
| sector_tags     | 0.20   | Fintech, healthtech, D2C, etc. |
| stage_tags      | 0.15   | Pre-seed vs growth-stage operator. |
| location        | 0.10   | Used as filter when specified; otherwise weight 0. |
| seniority       | 0.10   | Founder-level vs operator vs senior-IC. |
| summary_semantic| 0.10   | Free-text headline/summary catches the rest. |
| skills_raw      | ~0     | Noisy; intentionally down-weighted. |

---

## Prompt versioning

All prompts live under `src/llm/prompts/<name>_v<n>.ts`. Never edit a shipped version in place — bump the version number and update `CLAUDE.md` if the change is semantically significant.

Current versions:
- `voice_v3.ts` — conversational surface + intent classification; adds `topic_switch` (Batch B3), `force_intro`, and numbered-pick deterministic parsing (Batch B1)
- `refinement_v3.ts` — user turn → `RefinementDelta`
- `rerank_v4.ts` — top 8 → top 3 with reciprocal-fit rubric + `intro_recommendation` (warm/hold) + `hold_reason` (Batch B2). Schema defaults make it backwards-compatible with v3 responses.
- `explain_v1.ts` — 1-line rationale per card (used when rerank was skipped)
- `intro_v1.ts` — mutual-accept intro message

### Card rendering (post-Batch-B)

`runAndReply` picks between three shapes depending on the reranker output:

1. **Two cards, one outbound** — when two candidates come back warm and `score[1] >= 0.6 * score[0]`. Single `sendText` with a numbered body; typed `1` / `2` / `Skip` resolve deterministically via the classifier.
2. **Single warm card** — default. `sendButtons` with `Accept` / `Skip`.
3. **Single hold card** — when the top card is `intro_recommendation: "hold"`. Drawback slot becomes "Holding off on this intro: …"; `sendButtons` with `Force intro` / `Skip`. `onForceIntro` records `action = 'forced'` on `candidates_shown` so override rate is measurable.

In all three shapes the dispatcher writes exactly one `turns` row and one `sendButtons`/`sendText` call — the one-outbound-per-inbound contract is preserved.

---

## Latency budget

| Step | Target | Notes |
|---|---|---|
| Webhook 200 | <100ms | Dispatch async |
| "Finding matches…" ack | <300ms | Sent immediately after retrieval starts |
| Retrieval (embed + ANN) | <400ms | Cached embeddings for warm conversations |
| Rerank | <4s | 15 candidates, gpt-4.1 |
| Outbound send | <1s | WATI API |

Founder-visible latency from message → first candidate: target <6s.
