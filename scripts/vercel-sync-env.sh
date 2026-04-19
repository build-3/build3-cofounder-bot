#!/usr/bin/env bash
# Pushes every production secret from macOS Keychain into Vercel env vars.
# Idempotent — removes existing entry first, then re-adds. Non-interactive
# when VERCEL_TOKEN is set (create one at vercel.com/account/settings/tokens);
# otherwise the `vercel` CLI prompts via its own auth flow.
#
# Usage:
#   source ./scripts/load-env-from-keychain.sh   # populate shell first
#   ./scripts/vercel-sync-env.sh                 # push to Vercel production

set -eu

PREFIX="build3-cofounder-bot"

# env-var-name, "secret|plain" (plain means prompt-less echo, no Keychain read needed)
SECRET_KEYS=(
  DATABASE_URL
  OPENAI_API_KEY
  WATI_API_URL
  WATI_API_TOKEN
  WATI_WEBHOOK_SECRET
  ADMIN_TOKEN
)

# Constants — not secrets, baked into env for visibility in logs.
declare -A CONSTANTS=(
  [NODE_ENV]=production
  [LOG_LEVEL]=info
  [CONSENT_EXPIRY_HOURS]=72
)

# --- pre-flight --------------------------------------------------------------

if ! command -v vercel >/dev/null 2>&1; then
  echo "❌ vercel CLI not found. Install: npm i -g vercel"
  exit 1
fi

if ! vercel whoami >/dev/null 2>&1; then
  echo "❌ vercel CLI not authenticated."
  echo "   Either: export VERCEL_TOKEN=<token>  (vercel.com/account/settings/tokens)"
  echo "   Or:     vercel login                 (interactive browser flow)"
  exit 1
fi

if [[ ! -f .vercel/project.json ]]; then
  echo "❌ Project not linked. Run: vercel link"
  echo "   Select scope: build3 foundation's projects"
  echo "   Link to existing project: build3-cofounder-bot"
  exit 1
fi

# --- push secrets from Keychain ---------------------------------------------

for key in "${SECRET_KEYS[@]}"; do
  value=$(security find-generic-password -a "$USER" -s "$PREFIX/$key" -w 2>/dev/null || true)
  if [[ -z "$value" ]]; then
    echo "⚠  $key not in Keychain — skipping"
    continue
  fi
  # vercel env rm is interactive; pipe 'y' to auto-confirm
  vercel env rm "$key" production --yes >/dev/null 2>&1 || true
  printf "%s" "$value" | vercel env add "$key" production >/dev/null
  echo "✅ $key pushed to Vercel production"
done

# --- push constants ----------------------------------------------------------

for key in "${!CONSTANTS[@]}"; do
  value="${CONSTANTS[$key]}"
  vercel env rm "$key" production --yes >/dev/null 2>&1 || true
  printf "%s" "$value" | vercel env add "$key" production >/dev/null
  echo "✅ $key=$value pushed"
done

echo
echo "Done. Trigger a redeploy to pick them up:"
echo "  vercel deploy --prod --force"
