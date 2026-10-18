#!/usr/bin/env bash
# Codex Cloud setup: delegates to scripts/setup-environment.sh (install + npm test + npm run check).
set -euo pipefail
exec bash "$(dirname "$0")/../scripts/setup-environment.sh"
