#!/usr/bin/env bash
# Single source of truth for dev/Codex/devcontainer setup. No secrets needed.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
node -e 'const [major, minor] = process.versions.node.split(".").map(Number); if (major < 22 || (major === 22 && minor < 13)) { console.error("Node.js 22.13+ required (see .nvmrc). Run nvm install && nvm use."); process.exit(1); }'
if [[ -f package-lock.json ]]; then npm ci --no-audit --no-fund; else npm install --no-audit --no-fund; fi
if [[ ! -e .env ]]; then
  (umask 077; cp .env.example .env)
fi
if [[ "${SKIP_VALIDATE:-0}" != "1" ]]; then
  npm test
  npm run check
fi
printf '%s\n' 'Environment ready. Run npm run dev; use test-service credentials in .env for API integrations.'
