# Decisions Log (ADR-lite)

One entry per significant architectural choice. Format: **Decision → Why → Alternatives → Tradeoffs → Date**.

---

## ADR-001 — TypeScript + Fastify + Drizzle as the single service

- **Decision**: One long-running Node/TS service using Fastify for HTTP and Drizzle for the DB.
- **Why**: Tight Node/WhatsApp ecosystem, shared types between the webhook layer, the matcher, and the ingest script. Fastify's plugin/error-handling model keeps the webhook idempotency logic clean. Drizzle gives us typed SQL without a heavy ORM.
- **Alternatives considered**: Python + FastAPI (stronger LLM tooling but fragments types); Next.js API routes on Vercel (awkward for long-running background jobs and webhook retries).
- **Tradeoffs**: We lose Python's LLM ergonomics. Accepted — our LLM surface is small and well-isolated behind `LLMProvider`.
- **Date**: 2026-04-19

## ADR-002 — Supabase Postgres + pgvector for retrieval

- **Decision**: Managed Supabase Postgres with the `pgvector` extension; no dedicated vector DB.
- **Why**: ~1k founders is trivial for pgvector. One DB for relational + vector eliminates sync code. Supabase brings auth later if we ever expose APIs to founders directly.
- **Alternatives considered**: Pinecone/Weaviate (overkill at this scale, extra ops); Neon (fine but no bundled auth); self-hosted Postgres (more ops work).
- **Tradeoffs**: If the cohort grows 100x we'd revisit. At 1k founders, pgvector is fast enough.
- **Date**: 2026-04-19

## ADR-003 — Provider-agnostic LLM layer, OpenAI first

- **Decision**: All LLM work goes through a `LLMProvider` interface. OpenAI adapter is the MVP default; Gemini adapter is a stub from day 1.
- **Why**: OpenAI has the most mature JSON-mode + tool-use + embeddings surface today. Keeping the interface in place lets us A/B or switch without touching call sites.
- **Alternatives considered**: Build on Gemini directly (good if already on GCP); build on both in parallel (slower MVP).
- **Tradeoffs**: One layer of indirection. Accepted — it's thin and pays for itself the first time we want to compare providers.
- **Date**: 2026-04-19

## ADR-004 — Hybrid matching, not pure cosine similarity

- **Decision**: Three-layer matcher: pgvector ANN + structured filters → LLM rerank with a rubric → conversational refinement memory updates `search_state` each turn.
- **Why**: Pure cosine over all fields produces a matrimony-feel product and treats noisy skill lists as first-class signal. A rubric-based LLM rerank over a small top-N (15) gives us role/sector/stage/trajectory judgment that similarity can't express. Refinement memory makes the interaction feel like ChatGPT instead of a form.
- **Alternatives considered**: Pure cosine (too shallow); full recommender infra (overkill for MVP); LLM-over-entire-corpus (too slow + expensive).
- **Tradeoffs**: Rerank adds 3–8s latency on the top-N. Mitigated by sending an immediate "finding matches…" ack and keeping N small.
- **Date**: 2026-04-19

## ADR-005 — Synthetic seed data for dev and tests

- **Decision**: Ship `data/seed_founders.csv` with ~120 synthetic founders covering realistic role/sector/stage/location variance. Real cohort data is ingested separately and never committed.
- **Why**: We can develop, test, and dogfood the matching pipeline without waiting on a real cohort export. Synthetic data also makes CI deterministic.
- **Alternatives considered**: Block on real Airtable/CSV export; anonymized subset of real data (PII risk).
- **Tradeoffs**: Synthetic quirks may flatter the matcher. Mitigation: clearly mark synthetic data, and swap to real cohort before the pilot in Phase 6.
- **Date**: 2026-04-19

## ADR-006 — Mutual opt-in is a hard invariant

- **Decision**: No intro is sent and no target profile detail is revealed until both founders Accept. State machine enforces this; unit tests assert it.
- **Why**: Trust is the whole product. A single leak kills adoption across a tight cohort.
- **Alternatives considered**: "Soft intro" where the requester sees more target detail after their Accept. Rejected — it's a privacy asymmetry.
- **Tradeoffs**: Slightly slower path to intros. Accepted.
- **Date**: 2026-04-19

## ADR-007 — Prompts are versioned files, not inline strings

- **Decision**: Every LLM prompt lives in `src/llm/prompts/<name>_v<n>.ts`. Bump the version on change; don't edit in place.
- **Why**: Ranker quality depends on prompts. Versioned prompts give us diffable history and the option to A/B.
- **Alternatives considered**: Inline prompts (fast, but opaque); external prompt registry (overkill at this stage).
- **Tradeoffs**: Slightly more ceremony per change. Small.
- **Date**: 2026-04-19

## ADR-008 — Secrets live in macOS Keychain locally and Vercel env vars in prod; never in .env files on disk

- **Decision**: Local dev sources secrets from macOS Keychain (`security` CLI) via `scripts/load-env-from-keychain.sh`. CI/prod reads from Vercel project env vars. `.env.example` documents the contract; a populated `.env` is never created, committed, or shared.
- **Why**: A prior audit of `~/Documents/the_drool_company/.env` found plaintext OpenAI + WATI + Supabase keys sitting in a directory Finder, Spotlight, and Time Machine all index. Keychain entries are encrypted at rest, unlocked per-user per-session, and leave no searchable trace. Vercel handles the prod equivalent and lets us rotate without redeploying.
- **Alternatives considered**: Committed `.env.encrypted` + sops/age (extra tooling for a single-dev MVP); 1Password CLI (good, but adds a vendor + onboarding step); Doppler (another vendor). Keychain + Vercel needs zero extra infra.
- **Tradeoffs**: Teammates have to re-add secrets on first setup (documented in README). Acceptable — the cohort is one engineer right now.
- **Related action**: Also migrated `~/Documents/the_drool_company/.env` to the same Keychain service and left a backup at `.env.backup-pre-keychain` (chmod 600, gitignored) so nothing breaks for that project.
- **Date**: 2026-04-19

## ADR-009 — WATI workspace is Build3-owned (not drool_company)

- **Decision**: Reuse the existing WATI API credentials found in `the_drool_company/.env`; they are already provisioned under tenant `453532` with admin identity `tech@build3.org` (decoded from the JWT). The Build3 cofounder bot will send as Build3.
- **Why**: A flag in the initial audit called out a possible tenant mismatch. Decoding the JWT shows the token is issued to `tech@build3.org` under Build3's tenant, so the concern was unfounded. Documenting here so the next person doesn't re-raise it.
- **Alternatives considered**: Provisioning a new WATI workspace dedicated to the cofounder bot (slower, extra cost, no upside since the existing tenant is already Build3's).
- **Tradeoffs**: One WATI tenant serves multiple Build3 use cases; template/number contention is possible if other Build3 bots share it. Mitigation: reserve distinct template names (`cofounder_*`) and the shared secret is distinct per webhook.
- **Date**: 2026-04-19
