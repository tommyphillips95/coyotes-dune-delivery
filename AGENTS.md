# AGENTS.md

This repo is Coyote's Dune Delivery — a live vanilla JS + Netlify + Supabase app.

Shared desk for Grok + Claude + Codex: GitHub issues in this repo labeled `agent-task`.
Pick up work there, put the owner lane in the title (`[grok]`, `[claude]`, `[codex]`, `[tommy]`), and link the issue from your PR.

Read README.md and LAUNCH.md before changing behavior.

Summoning agents:
- Claude: mention `@claude` in an issue, PR comment, or PR review comment (`.github/workflows/claude.yml`, needs the `ANTHROPIC_API_KEY` repo secret).
- Codex: mention `@codex` in an issue or PR comment (ChatGPT Codex GitHub integration, connected by Tommy).
- Routing: `.github/workflows/grok.yml` reads the title prefix (`[claude]`/`[codex]`/`[grok]`/`[tommy]`, or a `claude`/`codex`/`grok` label) on `agent-task` issues. It adds an `agent-<name>` label and posts one routing comment (with `@claude`/`@codex` for those lanes). PRs into `main` or `agent/grok/cdd-launch-v1` get one Grok checklist comment.

Rules:
- Incremental PRs. Do not rewrite this into Next.js/RN as the first move.
- Branch `agent/<grok|claude|codex>/<slug>`
- Treat SSN/bank columns and README default passwords as security findings, not examples to copy.
- Prefer one backend (Netlify + Supabase). backend/server.js is missing; do not grow the Express leftover unless Tommy asks.
- Small PRs into the integration branch. CI (`.github/workflows/ci.yml`: `npm test` + `node --check` on netlify/functions) must pass before merge.
