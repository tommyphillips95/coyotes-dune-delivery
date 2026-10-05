#!/usr/bin/env bash
# Codex Cloud setup — runs once (or after cache miss) with network.
# Fail the environment if deps or tests break.
set -euo pipefail

cd "$(dirname "$0")/.."

echo "==> Coyote's Dune Delivery Codex setup"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is required (want v20)." >&2
  exit 1
fi

NODE_MAJOR="$(node -p "process.versions.node.split('.')[0]")"
if [[ "$NODE_MAJOR" -lt 20 ]]; then
  echo "Node $(node -v) found; need Node 20+. Install or switch before continuing." >&2
  exit 1
fi
echo "Node $(node -v)"

if [[ -f package-lock.json ]]; then
  echo "==> npm ci"
  npm ci --no-audit --no-fund
else
  echo "==> npm install (no package-lock.json in repo)"
  npm install --no-audit --no-fund
fi

echo "==> npm test"
npm test

echo "==> node --check netlify/functions"
set -e
for f in netlify/functions/*.js; do
  echo "node --check $f"
  node --check "$f"
done

echo "==> setup ok"
