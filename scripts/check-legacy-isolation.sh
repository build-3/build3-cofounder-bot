#!/usr/bin/env bash
# Fails if any file under src/ (outside src/_legacy/) imports from src/_legacy/.
# Keeps the old code truly decoupled from the live agent path.
set -euo pipefail

HITS=$(grep -rnE "from ['\"](\.\./)+_legacy/" src --include='*.ts' || true)
LEGACY_HITS=$(echo "$HITS" | grep -v '^src/_legacy/' || true)

if [ -n "$LEGACY_HITS" ]; then
  echo "ERROR: live code imports from src/_legacy/:" >&2
  echo "$LEGACY_HITS" >&2
  exit 1
fi
echo "legacy isolation OK"
