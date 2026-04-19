# Project State

_Rolling status log. Update this at the end of every meaningful step._

## Current phase

**Phase 6 — Ship** (in progress)

## Last changed

- 2026-04-19 — Secret hardening (ADR-008): migrated all plaintext secrets from `~/Documents/the_drool_company/.env` into macOS Keychain under service prefix `build3-cofounder-bot/`. Added `scripts/load-env-from-keychain.sh` (load into shell or `--print` for piping) and `scripts/setup-keychain.sh` (idempotent first-time prompts, `--force` overwrite). Rewrote drool `.env` to be a pointer-only file; backup at `.env.backup-pre-keychain` (chmod 600, gitignored). Tightened lovesosa `.gitignore` to block `.env*` except `.env.example`. `.env.example` now documents the Keychain contract with `__keychain:build3-cofounder-bot/<KEY>` sentinels. Also generated + stored a 39-char random `ADMIN_TOKEN`. WATI tenant flag resolved: JWT decodes to `tech@build3.org` / tenant `453532`, so the existing credentials are already Build3-owned (ADR-009).
- 2026-04-19 — Phase 6: admin routes (`src/admin/routes.ts`) with bearer-token auth (`ADMIN_TOKEN`) — `POST /admin/ingest` lazily imports the CSV ingester; `GET /admin/stats` returns counts over founders / conversations / turns / candidates_shown / match_requests-by-status. Registered under `/admin` in `src/server.ts`. Sample transcripts added below.
- 2026-04-19 — Phase 5: vitest + v8 coverage config; unit suites for `classifyIntent`, `normalizePhone`, `applyDelta` + `keywordDelta`, `assembleQuery` + `DEFAULT_WEIGHTS`, `fallbackIntro` privacy invariants, and `insertInboundTurn` idempotency contract via an injected fake sql client.
- 2026-04-19 — Phase 4: consent state machine (`src/consent/machine.ts`, the only writer of `match_requests.status`). Requester Accept → `propose()` (creates `proposed` row, sends consent prompt to target, transitions to `awaiting_mutual`, all in one DB transaction; unique active pair enforced). Target Accept → `onTargetAccept()` (mutual_accept → LLM intro draft with `intro_v1` + deterministic fallback → send to both sides → `intro_sent` + row in `intros`). Target Decline → `onTargetDecline()` (soft notice to requester; NO target identity beyond what was already shown). 72h expiry job (`src/consent/expiries.ts`) runs every 15 min in-process; requester gets a soft nudge, target is not contacted. Dispatcher decides side-of-accept by checking whether this founder is a target of an awaiting_mutual row.
- 2026-04-19 — Phase 3: hybrid retrieval (pgvector ANN cosine, k=50) with weighted query assembly and requester/shown exclusion; LLM rerank (top 15 → top 3) with rubric + Zod-validated JSON + deterministic fallback on parse failure; refinement extractor (LLM → `RefinementDelta`) with keyword-parse fallback; pure `applyDelta` merger; dispatcher rewired — discover/refine runs the pipeline, shows the top card with Accept/Skip buttons, Skip shows the next candidate, Accept is parked for Phase 4 consent SM. Prompts `refinement_v1`, `rerank_v1`, `explain_v1` are versioned files.
- 2026-04-19 — Phase 2: idempotent `POST /webhooks/wati` with shared-secret auth; outbound `WatiClient` (text/buttons/template) with retry/backoff; `identity/gate.ts` phone→founder with E.164 normalization; conversation store (turns + search_state) with DB-level idempotency; deterministic-first `classifyIntent` (accept/skip/decline/discover/refine/help); dispatcher with cohort gate + hello flow + placeholder matcher ack.
- 2026-04-19 — Phase 1: Drizzle schema + idempotent SQL migration 0001 (pgvector + ivfflat cosine index); 120-row synthetic founders CSV (deterministic seed=42); batched-embedding ingest via `LLMProvider`.
- 2026-04-19 — Phase 0: Fastify 5 skeleton, Zod config, pino logger, AppError hierarchy, `LLMProvider` interface, docs (7 ADRs, MATCHING, STATE_MACHINE, API_CONTRACTS), `git init` on `main`.

## What works right now

- `GET /healthz`
- `POST /webhooks/wati` — cohort gate, idempotent inbound, intent routing, matcher, candidate card with Accept/Skip buttons
- Full cofounder flow: discover → refine → Accept → target consent prompt → target Accept/Decline → intro-to-both or soft decline notice
- 72h expiry job running in-process (every 15 min) via `setInterval`, auto-starts with server
- `npm run seed:generate` / `npm run seed:load`

## What does not work yet

- No live deploy target wired up yet — host + webhook URL TBD (Railway/Render/Fly).
- No fake-WATI integration test (the unit suite exercises each seam; a full round-trip test is deferred).

## Next steps

1. Run `npm install` + `npm run typecheck` + `npm run test` on a machine with deps installed.
2. Apply migration 0001 to Supabase (or local Postgres + pgvector). Run `npm run seed:load`.
3. Pick a host, deploy, paste the webhook URL into WATI per CLAUDE.md, pilot with 3–5 founders.

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

These are the three canonical flows. If matcher/consent behavior changes, update these so new engineers and reviewers see current truth.

### 1. Cold start → 3-turn refinement → Accept → mutual accept → intro

```
Priya  → "hi"
Bot    → "Hey Priya 👋 — I'm the Build3 Cofounder Bot. Tell me in your own words what
          you're looking for. Examples: ..."
Priya  → "find me a sales cofounder"
Bot    → "Looking for good matches — one sec ⏳"
Bot    → [Card] Asha Kumar (Bangalore) — Growth lead, consumer fintech.
          Why: strong sales+BD background, seed-stage experience.
          [Accept] [Skip]
Priya  → "more B2B, Bangalore"
Bot    → [Card] Rohan Shah (Bangalore) — Enterprise sales @ B2B SaaS; 8 yrs.
          Why: B2B SaaS fit + Bangalore + founder-level trajectory.
          [Accept] [Skip]
Priya  → taps [Accept]
Bot    → "Nice — I've reached out to them. I'll ping you the moment they reply
          (or in 72h if they don't)."
                                                       …target side…
Bot    → [Card to Rohan] "Priya R. (Bangalore) wants to connect on Build3 Cofounder
          Bot. Why: B2B SaaS fit + Bangalore + founder-level trajectory.
          Tap Accept to let us intro you, or Decline to pass.
          [Accept] [Decline]"
Rohan  → taps [Accept]
Bot    → (to both) "Hey Priya and Rohan — you both said yes to an intro via Build3
          Cofounder Bot. ... Over to you."
```

### 2. Two skips → better candidate → Accept → target declines → fallback

```
Arjun  → "I want a technical cofounder, B2B, seed stage"
Bot    → [Card] Neha (Delhi NCR) — Tech lead, data platforms.
          [Accept] [Skip]
Arjun  → taps [Skip]
Bot    → "Got it — let me find someone else."
Bot    → [Card] Kabir (Bangalore) — Infra engineer, APIs.
          [Accept] [Skip]
Arjun  → taps [Skip]
Bot    → [Card] Ishaan (Bangalore) — Founding engineer, B2B SaaS; prior seed exit.
          [Accept] [Skip]
Arjun  → taps [Accept]
Bot    → "Nice — I've reached out to them."
                                                       …target side…
Ishaan → taps [Decline]
Bot    → (to Arjun) "Heads up — that founder passed on this one. Happy to keep
          looking. Reply with what to refine (role/sector/location/etc.) or say
          'next'."
```

### 3. Expired consent after 72h

```
Priya  → Accept on a candidate
Bot    → target receives consent prompt, state = awaiting_mutual
(target never replies)
…72h later, the expiry job fires…
Bot    → (to Priya) "That intro request expired without a reply. No problem —
          want me to find someone else? Just say what to refine."
```

_Any change to card copy, consent copy, or intro copy should come with a diff to
this section and a prompt-version bump per ADR-007._
