-- Admin login rate limit / lockout (draft; NOT run anywhere yet).
-- LAUNCH.md, SQL run order step 9.
--
-- One row per counter: key = 'ip:<client ip>' or 'user:<username>'.
-- login-admin (netlify/functions/_login-limit.js) counts failed sign-ins in a
-- 15-minute window and sets locked_until for 15 minutes at 5 failures per IP
-- or 20 per username. A successful sign-in clears both rows.
-- Until this runs, admin login still works with NO rate limit (timing-safe
-- password check only) and logs "admin_login_attempts table missing".
--
-- Strictly additive and re-runnable. Service role only: RLS on, no policies,
-- so the anon/public key can't read or write it.

CREATE TABLE IF NOT EXISTS admin_login_attempts (
  key             TEXT PRIMARY KEY,
  failures        INTEGER NOT NULL DEFAULT 0,
  first_failed_at TIMESTAMPTZ,
  locked_until    TIMESTAMPTZ,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE admin_login_attempts ENABLE ROW LEVEL SECURITY;

-- Verify (read-only, safe any time): expect one row, both values true.
SELECT
  EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'admin_login_attempts') AS has_table,
  COALESCE((SELECT relrowsecurity FROM pg_class WHERE oid = 'public.admin_login_attempts'::regclass), false) AS rls_on;
