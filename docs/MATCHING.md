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
- Prompt: `src/llm/prompts/rerank_v2.ts`.
- Rubric (each scored 0–3, summed):
  - Role fit
  - Reciprocal fit (does this founder appear to want the kind of counterpart the requester described?)
  - Sector fit
  - Stage fit
  - Location preference
  - Anti-pref avoidance (negative)
- Output: strict JSON `[{ founder_id, score, rationale }]`, validated via Zod. On parse failure: retry once; then fall back to retrieval order with a generic rationale.

Top 3 are returned. The top 1 is shown first; 2–3 are held for the next Skip.

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
- `voice_v2.ts` — conversational surface + intent classification
- `refinement_v3.ts` — user turn → `RefinementDelta`
- `rerank_v2.ts` — top 15 → top 3 with reciprocal-fit rubric
- `explain_v1.ts` — 1-line rationale per card (used when rerank was skipped)
- `intro_v1.ts` — mutual-accept intro message

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
