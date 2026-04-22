# CLAUDE.md — Build3 Cofounder Matching Bot

**Read this first if you are an agent or engineer new to this repo.** This file captures the non-obvious rules, the architecture at a glance, and the places you must update whenever you change something.

## What this project is

A WhatsApp-native cofounder-discovery bot for the Build3 founder cohort (~1k founders). Conversational, not a filter engine. Founders start broad ("find me a sales cofounder"), refine naturally ("more B2B, Bangalore, founder-level"), Accept/Skip suggested candidates, and intros happen only after mutual opt-in.

## Stack

- **Runtime**: Node 20, TypeScript (ESM)
- **HTTP**: Fastify 5
- **DB**: Supabase Postgres + `pgvector`
- **ORM**: Drizzle
- **LLM**: OpenAI (`gpt-4.1` + `text-embedding-3-small`) behind a `LLMProvider` interface. Gemini is a pluggable alternative.
- **WhatsApp**: WATI (webhook + REST)
- **Tests**: Vitest

## Commands

```
npm run dev            # local dev with tsx watch
npm run build          # tsc → dist/
npm run typecheck      # tsc --noEmit
npm run test           # vitest
npm run db:migrate     # run drizzle migrations against DATABASE_URL
npm run seed:generate  # regenerate data/seed_founders.csv
npm run seed:load      # ingest CSV → Postgres + embeddings
```

## Environment

Secrets live in **macOS Keychain** for local dev (service prefix `build3-cofounder-bot/`) and in **Vercel env vars** for prod. A populated `.env` must never be committed or sit in this repo. See ADR-008 in `docs/DECISIONS.md`.

Local workflow:
```
./scripts/setup-keychain.sh                # first-time — prompts for each secret
source ./scripts/load-env-from-keychain.sh # every shell session
```

`.env.example` documents the contract. `src/lib/config.ts` parses env with Zod at boot — a missing var is a hard startup failure.

## Architecture at a glance

```
WhatsApp → WATI → POST /webhooks/wati → InboundDispatcher
  → IdentityGate (phone → founder, cohort allowlist)
  → ConversationStore (turns, search_state)
  → IntentRouter → { discover | refine | accept | skip | decline }
      → MatchingPipeline (retrieve → rerank → explain)
      → RefinementExtractor (LLM → JSON delta → search_state)
      → ConsentStateMachine (proposed → awaiting_mutual → mutual_accept → intro_sent)
      → OutboundSender (WATI client) → WhatsApp
```

See `docs/` for deeper detail:
- `docs/PROJECT_STATE.md` — current status, blockers, next steps
- `docs/DECISIONS.md` — ADR log
- `docs/API_CONTRACTS.md` — route + webhook payloads
- `docs/MATCHING.md` — retrieval → rerank → refinement pipeline
- `docs/STATE_MACHINE.md` — consent/intro transitions + invariants

## Non-obvious rules

1. **Idempotency is mandatory.** Every inbound WATI message carries a `wati_message_id`. The `turns` table has a unique index on it. Re-deliveries MUST be no-ops — WATI retries aggressively.
2. **Never leak a target's profile pre-consent.** When a founder Accepts a candidate, the target sees only: requester's name, city, and a 1–2 line "why they want to talk". Enforced by `src/consent/machine.ts` and tested in `tests/consent/*.test.ts`.
3. **Prompts are versioned.** All LLM prompts live under `src/llm/prompts/` with a version suffix (e.g. `refinement_v1.ts`). When you change a prompt, bump the version — don't edit in place. This lets us diff-test ranker quality.

   Current versions (live path):
   - `agent_v2.ts` — agent system prompt (tightened buttons + no-match + greeting rules)
   - `refinement_v3.ts` — user turn → `RefinementDelta` (used by `update_search_state` tool)
   - `rerank_v4.ts` — retrieval → ranked candidates (used by `find_cofounders` tool)
   - `explain_v1.ts` — 1-line rationale per card
   - `intro_v1.ts` — mutual-accept intro message

   Legacy (in `src/_legacy/prompts/`, unreferenced):
   - `voice_v1`, `voice_v2`, `voice_v3` — old conversational surface
   - `rerank_v1`, `rerank_v2`, `rerank_v3` — old reranker prompts
4. **Raw `skills[]` is low-weight.** LinkedIn skills are noisy. `src/matching/weights.ts` intentionally de-emphasizes them. Reranker uses role/sector/stage/trajectory instead.
5. **Skip = soft negative signal**, not a ban. Implemented as a decayed anti-preference in `search_state.anti_prefs`.
6. **Deterministic path first (LEGACY — see rule 12).** The old intent router tried keyword matching before an LLM call. Now obsolete: the Gemini agent owns routing via function calls. Kept in `src/_legacy/` for reference only.
7. **Every LLM call has a fallback.** If the LLM returns invalid JSON twice, fall back to a deterministic path (keyword parse, static rationale, etc.) and log a warning. Never crash a conversation.
8. **Phone numbers are normalized to E.164** at both ingest and webhook boundaries. See `src/identity/gate.ts`.
9. **Consent requests expire in 72h** (`CONSENT_EXPIRY_HOURS`). The expiry job runs every 15 minutes.
10. **No PR gets merged without updating docs.** Principal-reviewer gate enforces `PROJECT_STATE.md` freshness.
11. **Whitelist-only during testing.** `src/wati/dispatcher.ts` hardcodes a 2-number allowlist (`917397599542`, `918468090511`). All other inbounds are silently dropped. Remove when rolling to full cohort.
12. **Agent owns the turn.** `src/agent/loop.ts:runAgent` is the single entry point. No intent classifier / router / templated card in the live path. Agent must call `finish_turn` exactly once per inbound.

## WATI wiring

- Inbound webhook: `POST /webhooks/wati` with header `X-Webhook-Secret: $WATI_WEBHOOK_SECRET`
- Events to enable in WATI dashboard: **Message Received**, **Interactive Message Reply** (button clicks). Message Status is optional.
- Outbound: `src/wati/client.ts` — `sendText`, `sendInteractiveButtons`, `sendTemplate` (templates only for 24h-window reopens).
- **Full dashboard config (what to disable, how to verify):** [`docs/WATI_CONFIG.md`](docs/WATI_CONFIG.md). Any auto-reply, welcome message, or chatbot keyword flow in the WATI dashboard will intercept messages before our webhook fires — keep that surface empty.

Exact string to paste into WATI once deployed:

```
Webhook URL: POST https://<PUBLIC_HOSTNAME>/webhooks/wati
Header name: X-Webhook-Secret
Header value: <value of WATI_WEBHOOK_SECRET>
```

## Git workflow

- One commit per meaningful step. Conventional commits (feat/fix/refactor/docs/test/chore/ci).
- Feature branches per phase: `phase/0-foundations`, `phase/1-data`, `phase/2-wati`, etc.
- `main` stays deployable.
- Attribution lines disabled globally — don't add Co-Authored-By to commits unless explicitly requested.

## What to touch when making changes

| If you change… | Also update… |
|---|---|
| A route or webhook payload | `docs/API_CONTRACTS.md` |
| The matching pipeline or prompts | `docs/MATCHING.md` + bump prompt version |
| Consent/intro flow | `docs/STATE_MACHINE.md` + tests |
| An architectural choice | `docs/DECISIONS.md` |
| Anything meaningful | `docs/PROJECT_STATE.md` |

If any of those are missing from a PR, the principal-reviewer gate fails.
