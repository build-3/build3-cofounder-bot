# Deploy

End-to-end wiring for the Build3 Cofounder Bot: Supabase (DB) → Vercel (runtime) → WATI (inbound).

---

## 1. Supabase

**Project provisioned** (via Supabase MCP on 2026-04-19):

| Field | Value |
|---|---|
| Name | `build3-cofounder-bot` |
| Ref | `vjzgptthyzzjtjcqpplq` |
| Region | `ap-southeast-1` (Singapore) |
| URL | `https://vjzgptthyzzjtjcqpplq.supabase.co` |
| Organization | Build3 |

**Extensions enabled**: `vector` (0.8.0), `pgcrypto` (1.3).

**Schema applied**: migration `0001_init` creates all 9 tables and the ivfflat cosine index on `founder_embeddings.embedding`. Verified via `list_tables` — 9 tables, 0 rows, RLS disabled (MVP; server uses service-role access only).

### Where the URL, anon key, and publishable key live

Already stashed in macOS Keychain under service prefix `build3-cofounder-bot/`:

- `SUPABASE_URL` — project URL
- `SUPABASE_ANON_KEY` — legacy anon JWT (for any client-side use later)
- `SUPABASE_PUBLISHABLE_KEY` — modern publishable key (`sb_publishable_…`)
- `SUPABASE_PROJECT_REF` — `vjzgptthyzzjtjcqpplq`

### DATABASE_URL (action required on first deploy)

The Supabase MCP does not surface the database password. Fetch it once from the Supabase Dashboard and stash it in Keychain:

1. Open https://supabase.com/dashboard/project/vjzgptthyzzjtjcqpplq/settings/database
2. Copy the **Connection string → URI** (transaction-mode pooler, port 6543). Shape:
   ```
   postgresql://postgres.vjzgptthyzzjtjcqpplq:<PASSWORD>@aws-0-ap-southeast-1.pooler.supabase.com:6543/postgres
   ```
3. Stash in Keychain:
   ```bash
   security add-generic-password -a "$USER" -s "build3-cofounder-bot/DATABASE_URL" -w "<paste URI>"
   ```
4. Verify:
   ```bash
   source ./scripts/load-env-from-keychain.sh
   echo "$DATABASE_URL" | sed 's/:[^:@]*@/:***@/'
   ```

Use the **direct** connection string (port 5432) only for one-off `drizzle-kit push` or migration work from a laptop. The runtime uses the pooler (6543) because Vercel functions are short-lived.

### Re-applying migrations

```bash
source ./scripts/load-env-from-keychain.sh
npm run db:migrate
```

Or via Supabase MCP: `apply_migration(project_id='vjzgptthyzzjtjcqpplq', name='000N_…', query='…')`.

---

## 2. Vercel

Framework preset: **Other** (pure Node, not Next.js). The service is a long-running Fastify process, so we deploy it as a Node runtime with a single catch-all function.

### Environment variables to set in Vercel

Project → Settings → Environment Variables. Apply to **Production + Preview**:

| Key | Value source |
|---|---|
| `DATABASE_URL` | Supabase pooler URI (see §1) |
| `OPENAI_API_KEY` | Keychain `build3-cofounder-bot/OPENAI_API_KEY` |
| `WATI_API_URL` | `https://live-mt-server.wati.io/453532` |
| `WATI_API_TOKEN` | Keychain `build3-cofounder-bot/WATI_API_TOKEN` |
| `WATI_WEBHOOK_SECRET` | Keychain `build3-cofounder-bot/WATI_WEBHOOK_SECRET` |
| `ADMIN_TOKEN` | Keychain `build3-cofounder-bot/ADMIN_TOKEN` |
| `NODE_ENV` | `production` |
| `LOG_LEVEL` | `info` |
| `CONSENT_EXPIRY_HOURS` | `72` |

Do not set `PORT` — Vercel injects it.

### Build + runtime

- Install command: `npm ci`
- Build command: `npm run build`
- Output: `dist/`
- Node version: **20.x** (matches local)

The 15-minute in-process `setInterval` for consent expiries assumes a long-running host. Vercel's serverless runtime kills idle functions, so expiries will fire only while a request is being served. For the pilot, a Vercel Cron (`/admin/run-expiries` hitting the expiry job) is the durable fix — tracked as a Phase 6 follow-up.

### Deploy steps

```bash
# First time
vercel link                       # choose Build3 scope
vercel env pull                   # sanity check
vercel deploy --prod
```

Smoke test:
```bash
curl -s https://<host>/healthz
# → { "ok": true }
```

---

## 3. WATI

Paste into WATI dashboard → Configure → Webhooks:

```
Webhook URL:  POST https://<vercel-host>/webhooks/wati
Header name:  X-Webhook-Secret
Header value: <value of WATI_WEBHOOK_SECRET>
Events:       Message Received, Interactive Message Reply
```

---

## 4. Rollback

- **DB**: Migrations are forward-only. To roll back 0001 on a non-prod branch, use `mcp__supabase__create_branch` → revert on the branch → test → `merge_branch` (or discard).
- **App**: Vercel keeps every deploy. `vercel rollback <url>` restores the previous green build.
- **Secrets**: Previous values live in Keychain until overwritten. `.env.backup-pre-keychain` (in the drool project) has the pre-migration snapshot.
