#!/usr/bin/env bash
# Load Build3 Cofounder Bot secrets from macOS Keychain into this shell.
#
# Usage:
#   source ./scripts/load-env-from-keychain.sh     # loads secrets into current shell
#   ./scripts/load-env-from-keychain.sh --print    # prints as KEY=value lines (for piping into Vercel, etc.)
#
# Secrets are stored as Keychain generic-password items under the
# `build3-cofounder-bot/<KEY>` service (one entry per key).
#
# To rotate a single secret:
#   security delete-generic-password -a "$USER" -s build3-cofounder-bot/OPENAI_API_KEY
#   security add-generic-password    -a "$USER" -s build3-cofounder-bot/OPENAI_API_KEY -w "<newvalue>"
#
# NEVER commit the output of --print. See docs/DECISIONS.md ADR-008 for why we
# chose Keychain over dotenv-in-repo.

set -eu

KEYCHAIN_SERVICE_PREFIX="build3-cofounder-bot"

# Keys the Fastify server expects. Keep in sync with src/lib/config.ts and .env.example.
KEYS=(
  # Build3 cohort-specific (required at startup):
  DATABASE_URL
  OPENAI_API_KEY
  WATI_API_BASE_URL      # mapped from Keychain key WATI_API_URL below
  WATI_API_TOKEN
  WATI_WEBHOOK_SECRET
  ADMIN_TOKEN

  # Optional / secondary:
  SUPABASE_URL
  SUPABASE_ANON_KEY
  GOOGLE_AI_KEY
)

# Some keys were imported from the drool env under slightly different names.
# Map them here: destination-var -> keychain-service-suffix.
declare_key() { printf '%s\n' "$1=$2"; }
MAPPINGS=$(cat <<'EOF'
WATI_API_BASE_URL=WATI_API_URL
EOF
)

resolve_keychain_suffix() {
  local key="$1"
  while IFS='=' read -r target source; do
    [[ -z "$target" ]] && continue
    if [[ "$target" == "$key" ]]; then
      printf '%s' "$source"
      return
    fi
  done <<< "$MAPPINGS"
  printf '%s' "$key"
}

MODE="${1:-source}"

missing=()
for k in "${KEYS[@]}"; do
  suffix=$(resolve_keychain_suffix "$k")
  if v=$(security find-generic-password -a "$USER" -s "$KEYCHAIN_SERVICE_PREFIX/$suffix" -w 2>/dev/null); then
    if [[ "$MODE" == "--print" ]]; then
      printf '%s=%s\n' "$k" "$v"
    else
      # shellcheck disable=SC2163
      export "$k=$v"
    fi
  else
    missing+=("$k (looked up $KEYCHAIN_SERVICE_PREFIX/$suffix)")
  fi
done

if [[ "$MODE" != "--print" ]]; then
  if (( ${#missing[@]} > 0 )); then
    printf '⚠️  %d secret(s) missing from Keychain:\n' "${#missing[@]}" >&2
    printf '   - %s\n' "${missing[@]}" >&2
    printf '   Add with: security add-generic-password -a "$USER" -s %s/<KEY> -w "<value>"\n' \
      "$KEYCHAIN_SERVICE_PREFIX" >&2
  fi
  printf '✅ loaded %d of %d secrets from macOS Keychain\n' \
    "$(( ${#KEYS[@]} - ${#missing[@]} ))" "${#KEYS[@]}" >&2
fi
