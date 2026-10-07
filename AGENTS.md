# AGENTS.md

This repo is Coyote's Dune Delivery — a live vanilla JS + Netlify + Supabase app.

Shared desk for Grok + Claude + Codex: GitHub issues in this repo labeled `agent-task`.
Pick up work there, put the owner lane in the title (`[grok]`, `[claude]`, `[codex]`, `[tommy]`), and link the issue from your PR.

Read README.md, LAUNCH.md, and (for Codex Cloud) `docs/codex-cloud.md` before changing behavior.

## Summoning agents

- **Claude:** mention `@claude` in an issue, PR comment, or PR review comment (`.github/workflows/claude.yml`, needs the `ANTHROPIC_API_KEY` repo secret). Workflows must be on the default branch (`main`) for `issues` / `issue_comment` events — see CI-only PR #19.
- **Codex:** mention `@codex` in an issue or PR comment (ChatGPT Codex GitHub integration). Bot user: `chatgpt-codex-connector[bot]`. Needs a Codex Cloud **environment** for this repo (see `docs/codex-cloud.md`).
- **Routing:** `.github/workflows/grok.yml` reads the title prefix (`[claude]`/`[codex]`/`[grok]`/`[tommy]`, or a `claude`/`codex`/`grok` label) on `agent-task` issues. It adds an `agent-<name>` label and posts one routing comment (with `@claude`/`@codex` for those lanes). PRs into `main` or `agent/grok/cdd-launch-v1` get one Grok checklist comment.

## Codex Cloud

Container model: **setup** (network on) → optional **maintenance** on cache resume → **agent loop** (reads this file; internet off by default).

| Setting | Value |
|---|---|
| Environment repo | `tommyphillips95/coyotes-dune-delivery` |
| Default work branch | `agent/grok/cdd-launch-v1` — **never push straight to `main`** |
| Node | 22 (22.13+, see `.nvmrc`) |
| Setup script | `bash scripts/setup-environment.sh` (`.codex/setup.sh` wraps it) |
| Maintenance script | `bash scripts/setup-environment.sh` (`.codex/maintenance.sh` wraps it with `SKIP_VALIDATE=1`) |
| Validate | `npm test && npm run check` (same as CI) |
| Run locally | `npm run dev` (Netlify Dev, offline, port 8888) |
| Agent branches | `agent/codex/<slug>` |
| Open PRs into | `agent/grok/cdd-launch-v1` |
| Summon | `@codex` on an `agent-task` issue or PR comment |
| Internet | **Setup/maintenance:** on (npm). **Agent:** off by default; prefer mocked unit tests, no live Stripe/Supabase calls unless Tommy asks |
| Secrets | None needed. Never invent keys; root `.env.example` lists names only |

Live site: `https://coyote-dune-delivery.netlify.app`. Stripe webhook URL: `https://coyote-dune-delivery.netlify.app/api/payment-webhook`. See `docs/codex-cloud.md` and `docs/development-environment.md`.

## Rules

- Incremental PRs. Do not rewrite this into Next.js/RN as the first move.
- Branch `agent/<grok|claude|codex>/<slug>`
- Treat SSN/bank columns and README default passwords as security findings, not examples to copy.
- Prefer one backend (Netlify + Supabase). `backend/server.js` is missing; do not grow the Express leftover unless Tommy asks.
- Small PRs into the integration branch. CI (`.github/workflows/ci.yml`: `npm test` + `node --check` on netlify/functions) must pass before merge.
