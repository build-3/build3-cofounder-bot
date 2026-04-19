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

# Env-var names are what the Fastify server expects at runtime
# (see src/lib/config.ts). Keychain suffixes may differ — see SECRET_SRC below
# for the mapping. Keep this list in sync with src/lib/config.ts.
SECRET_KEYS=(
  DATABASE_URL
  OPENAI_API_KEY
  WATI_API_BASE_URL
  WATI_API_TOKEN
  WATI_WEBHOOK_SECRET
  ADMIN_TOKEN
)

# Map env-var-name -> Keychain service suffix. Any key not in this map uses its
# own name as the Keychain suffix.
keychain_suffix_for() {
  case "$1" in
    WATI_API_BASE_URL) echo "WATI_API_URL" ;;
    *)                 echo "$1" ;;
  esac
}

# Constants — not secrets, baked into env for visibility in logs.
# Parallel arrays (bash 3.2 compat).
CONSTANT_KEYS=(NODE_ENV LOG_LEVEL CONSENT_EXPIRY_HOURS)
CONSTANT_VALS=(production info 72)

# --- pre-flight --------------------------------------------------------------

if ! command -v vercel >/dev/null 2>&1; then
  echo "❌ vercel CLI not found. Install: npm i -g vercel"
  exit 1
fi

if ! vercel whoami ${VERCEL_TOKEN:+--token "$VERCEL_TOKEN"} >/dev/null 2>&1; then
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
  src=$(keychain_suffix_for "$key")
  value=$(security find-generic-password -a "$USER" -s "$PREFIX/$src" -w 2>/dev/null || true)
  if [[ -z "$value" ]]; then
    echo "⚠  $key (Keychain: $PREFIX/$src) not found — skipping"
    continue
  fi
  # vercel env rm is interactive; pipe 'y' to auto-confirm
  vercel env rm "$key" production --yes ${VERCEL_TOKEN:+--token "$VERCEL_TOKEN"} >/dev/null 2>&1 || true
  printf "%s" "$value" | vercel env add "$key" production ${VERCEL_TOKEN:+--token "$VERCEL_TOKEN"} >/dev/null
  echo "✅ $key pushed to Vercel production"
done

# --- push constants ----------------------------------------------------------

for i in "${!CONSTANT_KEYS[@]}"; do
  key="${CONSTANT_KEYS[$i]}"
  value="${CONSTANT_VALS[$i]}"
  vercel env rm "$key" production --yes ${VERCEL_TOKEN:+--token "$VERCEL_TOKEN"} >/dev/null 2>&1 || true
  printf "%s" "$value" | vercel env add "$key" production ${VERCEL_TOKEN:+--token "$VERCEL_TOKEN"} >/dev/null
  echo "✅ $key=$value pushed"
done

echo
echo "Done. Trigger a redeploy to pick them up:"
echo "  vercel deploy --prod --force"
