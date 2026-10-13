# Coyote Dune Delivery development environment

This repository runs a static frontend and Netlify Functions. Use the root package;
`legacy/express-backend/` is a quarantined Express scaffold (not deployed, missing its entry point). Netlify Functions are the only backend; see `docs/backend.md`.

## Local development or GitHub Codespaces

Open this repository in Codespaces or VS Code's Dev Containers extension. The
container uses Node 22 and runs the setup script automatically. Alternatively:

```sh
nvm install
nvm use
bash scripts/setup-environment.sh
npm run dev
```

Open http://localhost:8888. Netlify Dev serves `frontend/`, local functions,
redirects, and headers using `netlify.toml`. The command does not deploy or
require linking to a production Netlify site. Do not link this development
checkout to production: linked Netlify projects may inject remote credentials.

`npm run check` validates JavaScript syntax without calling external services.
`npm test` runs the unit tests (quote parity + mocked payment/auth hardening).

## Codex cloud configuration

Create a cloud environment for `tommyphillips95/coyotes-dune-delivery`:

- Name: Coyote Dune Delivery
- Work branch: `agent/grok/cdd-launch-v1` (never push to `main`).
- Node version: 22 (at least 22.13).
- Setup script: `bash scripts/setup-environment.sh`
- Maintenance script: `bash scripts/setup-environment.sh`
- Run command: `npm run dev`
- Validation command: `npm test && npm run check`
- No secrets needed for installation, syntax checks, or static previews.

The setup phase needs npm registry access. Agent-phase internet access can stay
at its default unless a task needs external access. Never make setup call the
payment, SMS, background-check, or production database services.

## Test-service configuration

Setup creates an ignored `.env` from `.env.example` only if it does not already
exist. Fill it with isolated test-service credentials when validating integrations:
Supabase test project URL/service key, unique admin credentials/JWT secret,
Stripe test secret and webhook keys, optional Twilio test credentials, Checkr
sandbox credentials, and optional Firebase test project service-account JSON.
No usable keys or default passwords are supplied. Blank keys mean those API
integrations cannot run; this environment does not mock them.

Existing browser-side service configuration is separate and must be reviewed
before submitting orders, applications, payments, or sending notifications.
The environment setup does not provision a database, import `schema.sql`,
create paid cloud resources, or enable production transactions.

Follow `AGENTS.md`: branch `agent/codex/<slug>` and open a PR into
`agent/grok/cdd-launch-v1`. The work desk is this repo's `agent-task` issues.
