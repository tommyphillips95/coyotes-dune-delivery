#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
node -e 'const [major, minor] = process.versions.node.split(".").map(Number); if (major < 22 || (major === 22 && minor < 13)) { console.error("Node.js 22.13+ required. Run nvm install && nvm use."); process.exit(1); }'
npm ci --no-audit --no-fund
if [[ ! -e .env ]]; then
  (umask 077; cp .env.example .env)
fi
npm run check
printf '%s\n' 'Environment ready. Run npm run dev; use test-service credentials in .env for API integrations.'
