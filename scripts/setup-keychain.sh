#!/usr/bin/env bash
# First-time setup: prompt for each missing secret and store it in macOS Keychain.
# Safe to re-run — existing entries are shown and skipped unless --force is passed.
#
# Usage:
#   ./scripts/setup-keychain.sh           # prompt for missing only
#   ./scripts/setup-keychain.sh --force   # re-prompt for every key (overwrites)

set -eu

PREFIX="build3-cofounder-bot"
FORCE="${1:-}"

# (env-var-name, keychain-suffix, prompt-help-text)
# Using parallel arrays for bash 3.2 compatibility.
NAMES=(
  DATABASE_URL
  OPENAI_API_KEY
  WATI_API_URL
  WATI_API_TOKEN
  WATI_WEBHOOK_SECRET
  ADMIN_TOKEN
  SUPABASE_URL
  SUPABASE_ANON_KEY
  GOOGLE_AI_KEY
)
HELP=(
  "Supabase Postgres URI — Project Settings → Database → 'Connection string (URI)'"
  "OpenAI API key — starts with sk-proj- or sk-"
  "WATI base URL including tenant id — e.g. https://live-mt-server.wati.io/453532"
  "WATI API token — starts with 'Bearer '"
  "Any long random string; paste the same value into WATI webhook X-Webhook-Secret"
  "Bearer token for /admin/* routes (auto-generate: openssl rand -base64 32)"
  "Supabase project URL — https://<ref>.supabase.co"
  "Supabase anon key — starts with eyJ…"
  "Google AI (Gemini) API key — optional; leave blank to skip"
)

exists() {
  security find-generic-password -a "$USER" -s "$PREFIX/$1" -w >/dev/null 2>&1
}

prompt_and_store() {
  local key="$1" help="$2"
  echo
  echo "── $key ──"
  echo "   $help"
  printf "   value (paste, empty to skip): "
  # -s hides input
  IFS= read -rs value
  echo
  if [[ -z "$value" ]]; then
    echo "   ↷ skipped"
    return
  fi
  security delete-generic-password -a "$USER" -s "$PREFIX/$key" >/dev/null 2>&1 || true
  security add-generic-password -a "$USER" -s "$PREFIX/$key" -w "$value"
  echo "   ✅ stored in Keychain as $PREFIX/$key"
}

for i in "${!NAMES[@]}"; do
  key="${NAMES[$i]}"
  help="${HELP[$i]}"
  if exists "$key" && [[ "$FORCE" != "--force" ]]; then
    echo "✓ $key already in Keychain (use --force to overwrite)"
    continue
  fi
  prompt_and_store "$key" "$help"
done

echo
echo "Done. To load into your shell:"
echo "  source ./scripts/load-env-from-keychain.sh"
