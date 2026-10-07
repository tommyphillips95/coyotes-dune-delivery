# Codex Cloud environment — Coyote's Dune Delivery

This guide wires ChatGPT Codex Cloud to `tommyphillips95/coyotes-dune-delivery` so Codex can: create a container → run setup → (maintenance on cache resume) → agent loop with `AGENTS.md` → open a PR into `agent/grok/cdd-launch-v1`.

## Prerequisites

1. ChatGPT account with Codex Cloud.
2. GitHub connected in ChatGPT (the `chatgpt-codex-connector` GitHub App must see this repo).
3. Scripts already in the repo (on `agent/grok/cdd-launch-v1`):
   - `scripts/setup-environment.sh` (wrapped by `.codex/setup.sh` / `.codex/maintenance.sh`)
   - `AGENTS.md` (Codex Cloud section)

> **PR #19** (CI-only workflows onto `main`) is separate: it enables GitHub Actions `grok.yml` routing comments from the default branch. The Codex **app** can still run tasks once the Cloud environment exists, even before #19 merges.

## Create the environment (copy-paste)

1. Open [Codex Cloud environments](https://chatgpt.com/codex/cloud/settings/environments).
2. **Create environment** → point it at GitHub repo **`tommyphillips95/coyotes-dune-delivery`**.
3. Default / base branch for work: prefer **`agent/grok/cdd-launch-v1`** (integration branch). Do not use `main` as the agent push target.
4. **Setup script** — paste path or contents of:

   ```text
   bash scripts/setup-environment.sh
   ```

   Node 22 (22.13+). Setup runs with network (npm). It runs `npm ci`, then `npm test` + `npm run check`, so a broken tree fails early. No secrets needed.

5. **Maintenance script** — paste:

   ```text
   bash scripts/setup-environment.sh
   ```

   Runs on cache resume. (`.codex/maintenance.sh` is the same script with `SKIP_VALIDATE=1`.)

6. **Internet policy**
   - Setup / maintenance: **allow** (needed for `npm install`).
   - Agent phase: **off** by default. Prefer mocked tests in `tests/`. Only enable agent network if Tommy asks for live API calls.

7. **Publish** the environment.

8. Start a task from ChatGPT **Work in Cloud**, or comment on a GitHub `agent-task` issue:

   ```text
   @codex please pick this up: follow AGENTS.md, branch agent/codex/<slug>, open a small PR into agent/grok/cdd-launch-v1, and make sure CI passes.
   ```

## Validate locally (same as setup)

```bash
bash scripts/setup-environment.sh
# or:
npm test && npm run check
```

## Stripe / live site notes (for agents)

- Live site: `https://coyote-dune-delivery.netlify.app`
- Stripe webhook endpoint to configure in Stripe Dashboard:

  ```text
  https://coyote-dune-delivery.netlify.app/api/payment-webhook
  ```

  Events: `payment_intent.succeeded`, `payment_intent.payment_failed`, `payment_intent.canceled` (and refunds if used).

- Frontend publishable key: set Netlify env `STRIPE_PUBLISHABLE_KEY`. The order page loads it via `GET /api/public-config` (or `window.STRIPE_PUBLISHABLE_KEY` override). Never put `STRIPE_SECRET_KEY` in frontend code.
- Secrets stay in Netlify / ChatGPT secrets UI — never invent or commit real values. See root `.env.example`.

## Branch / PR rules

| Do | Don't |
|---|---|
| Branch `agent/codex/<slug>` | Push to `main` |
| PR into `agent/grok/cdd-launch-v1` | Merge to `main` without Tommy |
| Link `Closes #N` for `agent-task` issues | Invent API keys |
| Keep PRs small; CI green | Grow Express `backend/` unless asked |
