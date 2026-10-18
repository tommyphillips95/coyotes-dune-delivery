# QUARANTINED: legacy Express backend (not deployed)

This folder is the old Express + SQLite scaffold from before the Netlify move.
**It is not part of production and cannot run.** Its entry point
(`server.js`, plus `database.js` that the routes require) was never committed.

- Production is **Netlify Functions + Supabase** only: `netlify.toml` publishes
  `frontend/` and serves `/api/*` from `netlify/functions/`. See `docs/backend.md`.
- Nothing in `frontend/`, `netlify/functions/`, CI, or the deploy reads this
  folder. `tests/single-backend.test.js` fails if that changes.
- Kept only as reference while the remaining Express-shaped frontend calls
  (driver application upload, admin dashboard) are ported to functions.
  Do not add code here, do not deploy it, and do not copy its patterns
  (SQLite on disk, default admin passwords, SSN/bank fields stored as plain text).

Delete this folder once those ports land (issue #11 follow-up).
