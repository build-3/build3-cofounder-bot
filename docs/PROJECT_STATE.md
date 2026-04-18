# Project State

_Rolling status log. Update this at the end of every meaningful step._

## Current phase

**Phase 2 — WATI integration** (in progress)

## Last changed

- 2026-04-19 — Phase 2: idempotent `POST /webhooks/wati` with shared-secret auth; outbound `WatiClient` (text/buttons/template) with retry/backoff; `identity/gate.ts` phone→founder with E.164 normalization; conversation store (turns + search_state) with DB-level idempotency; deterministic-first `classifyIntent` (accept/skip/decline/discover/refine/help); dispatcher with cohort gate + hello flow + placeholder matcher ack.
- 2026-04-19 — Phase 1: Drizzle schema + idempotent SQL migration 0001 (pgvector + ivfflat cosine index); 120-row synthetic founders CSV (deterministic seed=42); batched-embedding ingest via `LLMProvider`.
- 2026-04-19 — Phase 0: Fastify 5 skeleton, Zod config, pino logger, AppError hierarchy, `LLMProvider` interface, docs (7 ADRs, MATCHING, STATE_MACHINE, API_CONTRACTS), `git init` on `main`.

## What works right now

- `GET /healthz` → `{ ok: true, ts: ... }`
- `POST /webhooks/wati` with `X-Webhook-Secret` accepts WATI payloads, verifies secret, idempotently inserts inbound turns, routes to the dispatcher, and replies via WATI with a hello/ack message
- `npm run seed:generate` writes `data/seed_founders.csv` deterministically
- `npm run seed:load` embeds + upserts founders into Postgres (when DB is live)

## What does not work yet

- No matching pipeline (Phase 3) — dispatcher currently sends a placeholder "Phase 3" ack for discover/refine
- No consent flow or 72h expiry job (Phase 4)
- No tests yet (Phase 5) — dispatcher logic is pending test coverage

## Next steps

1. **Phase 1** — Drizzle schema, pgvector setup, synthetic founders CSV generator, ingest script with embeddings.
2. **Phase 2** — Idempotent WATI webhook, outbound WATI client, identity gate, hello flow.
3. **Phase 3** — Retriever + reranker + refinement extractor + explain.
4. **Phase 4** — Consent state machine + 72h expiry + intro draft.
5. **Phase 5** — Tests (unit + fake-WATI integration).
6. **Phase 6** — Deploy + pilot.

## Blockers / open questions

| # | Item | Severity | Notes |
|---|---|---|---|
| 1 | OpenAI API key | blocks any real LLM call | `.env` placeholder in use |
| 2 | Supabase DB URL + pgvector enabled | blocks Phase 1 deploy-to-dev | can develop locally with Postgres+vector ext |
| 3 | WATI API token + base URL | blocks outbound send | can mock for unit/integration tests |
| 4 | Public hostname for webhook | blocks live smoke | not needed until Phase 6 |
| 5 | GitHub remote URL | blocks `git push` | local commits continue meanwhile |

## Handoff notes (read me if picking this up cold)

- Start in `CLAUDE.md` for the rules. This file (`PROJECT_STATE.md`) is the "what's happening right now" log.
- The plan lives at `/Users/arjun/.claude/plans/role-you-are-claude-misty-pearl.md`.
- Every phase ends with a conventional-commit. Look at `git log` for the audit trail.
- Synthetic founder data is committed at `data/seed_founders.csv`. Real cohort data should never be committed — `.gitignore` blocks `data/real_*.csv` and `*.private.csv`.

## Sample conversations (keep in sync with matcher behavior)

_Filled in during Phase 3._
