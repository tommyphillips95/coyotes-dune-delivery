-- Driver application consent records (draft; NOT run anywhere yet).
-- LAUNCH.md, SQL run order step 8.
--
-- Adds four nullable columns to applications. Strictly additive and
-- re-runnable: every statement is ADD COLUMN IF NOT EXISTS, so a second run
-- changes nothing. No data is changed or deleted; existing rows stay NULL.
--
--   background_check_disclosure_read  form box bgDisclosureRead ("I have read the disclosure")
--   esignature_consent                form box esignature (sign electronically)
--   terms_consent                     form box termsAgree (info confirmed + terms agreed)
--   consents_accepted_at              server time submit-application accepted all four
--
-- background_check_consent (form box bgConsent) already exists in schema.sql.
-- submit-application rejects an application unless all four boxes are ticked,
-- and saves applications without these columns (with a log warning) until
-- this file is run.

ALTER TABLE applications ADD COLUMN IF NOT EXISTS background_check_disclosure_read BOOLEAN;
ALTER TABLE applications ADD COLUMN IF NOT EXISTS esignature_consent BOOLEAN;
ALTER TABLE applications ADD COLUMN IF NOT EXISTS terms_consent BOOLEAN;
ALTER TABLE applications ADD COLUMN IF NOT EXISTS consents_accepted_at TIMESTAMPTZ;

-- Verify (read-only, safe any time): expect one row, all four values true.
SELECT
  EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'applications' AND column_name = 'background_check_disclosure_read' AND data_type = 'boolean' AND is_nullable = 'YES') AS has_disclosure_read,
  EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'applications' AND column_name = 'esignature_consent' AND data_type = 'boolean' AND is_nullable = 'YES') AS has_esignature,
  EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'applications' AND column_name = 'terms_consent' AND data_type = 'boolean' AND is_nullable = 'YES') AS has_terms,
  EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'applications' AND column_name = 'consents_accepted_at' AND data_type = 'timestamp with time zone' AND is_nullable = 'YES') AS has_accepted_at;
