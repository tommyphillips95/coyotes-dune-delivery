#!/usr/bin/env bash
# Codex Cloud maintenance (cache resume): same script, skip validation for speed.
set -euo pipefail
SKIP_VALIDATE=1 exec bash "$(dirname "$0")/../scripts/setup-environment.sh"
