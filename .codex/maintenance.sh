#!/usr/bin/env bash
# Codex Cloud maintenance — fast, idempotent refresh of node_modules on cache resume.
set -euo pipefail

cd "$(dirname "$0")/.."

echo "==> Coyote's Dune Delivery Codex maintenance"

if [[ -f package-lock.json ]]; then
  echo "==> npm ci"
  npm ci --no-audit --no-fund
else
  echo "==> npm install"
  npm install --no-audit --no-fund
fi

echo "==> maintenance ok"
