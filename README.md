# Build3 Cofounder Matching Bot

A WhatsApp-native conversational cofounder-discovery bot for the Build3 internal founder cohort.

- **What**: Founders message on WhatsApp → bot suggests cofounder candidates → refine naturally → Accept / Skip → mutual opt-in → intro.
- **Why WhatsApp**: cohort-level adoption is trivial there; a new app is not.
- **Why conversational**: a filter engine feels like matrimony. We want ChatGPT-style refinement.

## Stack

TypeScript · Fastify · Drizzle · Supabase Postgres + pgvector · OpenAI · WATI.

## Quick start

```bash
git clone <repo>
cd build3-cofounder-bot
npm install

# Secrets live in macOS Keychain, not in a committed .env. See ADR-008.
# First time on a new machine:
./scripts/setup-keychain.sh        # prompts for each missing secret

# Every subsequent shell:
source ./scripts/load-env-from-keychain.sh
npm run db:migrate
npm run seed:generate              # creates data/seed_founders.csv
npm run seed:load                  # ingests CSV → Postgres + embeddings
npm run dev                        # http://localhost:3000
```

### Where secrets come from

| Environment | Source | Rotation |
|---|---|---|
| Local dev | macOS Keychain (`security` CLI) under service prefix `build3-cofounder-bot/` | `security delete-…` then `add-generic-password` |
| Vercel preview/prod | Project → Settings → Environment Variables | Vercel dashboard; redeploy to pick up |
| CI (future) | GitHub Actions secrets | GitHub repo settings |

`.env.example` documents the contract but must never be populated and committed. `.gitignore` blocks `.env*` except `.env.example`.

## Where to look first

- `CLAUDE.md` — rules, architecture, non-obvious things
- `docs/PROJECT_STATE.md` — what's done, what's next, blockers
- `docs/MATCHING.md` — retrieval → rerank → refinement
- `docs/STATE_MACHINE.md` — consent + intro flow
- `docs/API_CONTRACTS.md` — inbound + outbound payloads
- `docs/DECISIONS.md` — ADR log

## Deploy (once Phase 6 hits)

Deploy target is TBD (Railway / Render / Fly). After deploy, in the WATI dashboard:

```
Webhook URL:  POST https://<your-host>/webhooks/wati
Header:       X-Webhook-Secret: <value of WATI_WEBHOOK_SECRET>
Events:       Message Received + Interactive Message Reply
```
