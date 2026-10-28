-- verify-schema.sql — READ-ONLY post-deploy schema check for Coyote's Dune Delivery.
-- Run AFTER LAUNCH.md "Before the next production deploy" steps 5, 6 (optional), 7, 8,
-- 9 (recommended) and the driver-documents bucket. Only SELECTs from information_schema, pg_catalog,
-- pg_indexes and storage.buckets. It changes nothing and reads no customer data.
-- Paste the whole file in Supabase SQL Editor. Result: one row per check with
-- step, check, ok (true/false) and detail. Every REQUIRED row should be ok = true;
-- step 6 rows are OPTIONAL (false just means step 6 was skipped or the unique
-- index was held back by duplicate phones). Step 9 rows are optional too
-- (recommended): false means admin login and the per-IP limits run unlimited.

WITH checks(step, required, check_name, ok, detail) AS (
  -- ── Step 5: schema/order_idempotency.sql ───────────────────────────
  SELECT '5', true, 'orders.idempotency_key column (text)',
         EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'orders'
                    AND column_name = 'idempotency_key' AND data_type = 'text'),
         'ALTER TABLE orders ADD COLUMN idempotency_key TEXT'
  UNION ALL
  SELECT '5', true, 'orders.idempotency_payload_hash column (text)',
         EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'orders'
                    AND column_name = 'idempotency_payload_hash' AND data_type = 'text'),
         'ALTER TABLE orders ADD COLUMN idempotency_payload_hash TEXT'
  UNION ALL
  SELECT '5', true, 'orders_idempotency_key_uidx: UNIQUE on (idempotency_key) WHERE idempotency_key IS NOT NULL',
         EXISTS (SELECT 1 FROM pg_index i
                   JOIN pg_class c ON c.oid = i.indexrelid
                   JOIN pg_class t ON t.oid = i.indrelid
                   JOIN pg_namespace n ON n.oid = t.relnamespace
                  WHERE n.nspname = 'public' AND t.relname = 'orders'
                    AND c.relname = 'orders_idempotency_key_uidx'
                    AND i.indisunique AND i.indisvalid
                    AND pg_get_indexdef(i.indexrelid) ILIKE '%(idempotency_key)%'
                    AND pg_get_expr(i.indpred, i.indrelid) ILIKE '%idempotency_key IS NOT NULL%'),
         coalesce((SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'orders_idempotency_key_uidx'), 'index missing')

  -- ── Step 6 (optional): schema/customer_phone_normalize.sql ─────────
  UNION ALL
  SELECT '6', false, 'function cdd_phone_key(text) returns text, IMMUTABLE',
         EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                  WHERE n.nspname = 'public' AND p.proname = 'cdd_phone_key'
                    AND pg_get_function_identity_arguments(p.oid) = 'p text'
                    AND p.prorettype = 'text'::regtype AND p.provolatile = 'i'),
         'CREATE FUNCTION cdd_phone_key(p TEXT) ... IMMUTABLE'
  UNION ALL
  SELECT '6', false, 'customers.phone_normalized column (text)',
         EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'customers'
                    AND column_name = 'phone_normalized' AND data_type = 'text'),
         'ALTER TABLE customers ADD COLUMN phone_normalized TEXT'
  UNION ALL
  SELECT '6', false, 'trigger function customers_phone_normalized_sync() returns trigger',
         EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                  WHERE n.nspname = 'public' AND p.proname = 'customers_phone_normalized_sync'
                    AND p.prorettype = 'trigger'::regtype),
         'CREATE FUNCTION customers_phone_normalized_sync() RETURNS trigger'
  UNION ALL
  SELECT '6', false, 'trigger customers_phone_normalized_sync on customers (BEFORE INSERT OR UPDATE OF phone, enabled)',
         EXISTS (SELECT 1 FROM pg_trigger tg
                   JOIN pg_class t ON t.oid = tg.tgrelid
                   JOIN pg_namespace n ON n.oid = t.relnamespace
                  WHERE n.nspname = 'public' AND t.relname = 'customers'
                    AND tg.tgname = 'customers_phone_normalized_sync' AND NOT tg.tgisinternal
                    AND tg.tgenabled <> 'D'
                    AND pg_get_triggerdef(tg.oid) ILIKE '%BEFORE INSERT OR UPDATE OF phone%FOR EACH ROW%customers_phone_normalized_sync()%'),
         coalesce((SELECT pg_get_triggerdef(tg.oid) FROM pg_trigger tg JOIN pg_class t ON t.oid = tg.tgrelid
                    WHERE t.relname = 'customers' AND tg.tgname = 'customers_phone_normalized_sync' LIMIT 1), 'trigger missing')
  UNION ALL
  SELECT '6', false, 'idx_customers_phone_normalized (lookup index)',
         EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'customers'
                    AND indexname = 'idx_customers_phone_normalized' AND indexdef ILIKE '%(phone_normalized)%'),
         coalesce((SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'idx_customers_phone_normalized'), 'index missing')
  UNION ALL
  SELECT '6', false, 'customers_phone_normalized_uidx: UNIQUE WHERE phone_normalized IS NOT NULL (skipped by the script if duplicate phones exist)',
         EXISTS (SELECT 1 FROM pg_index i
                   JOIN pg_class c ON c.oid = i.indexrelid
                   JOIN pg_class t ON t.oid = i.indrelid
                   JOIN pg_namespace n ON n.oid = t.relnamespace
                  WHERE n.nspname = 'public' AND t.relname = 'customers'
                    AND c.relname = 'customers_phone_normalized_uidx'
                    AND i.indisunique AND i.indisvalid
                    AND pg_get_expr(i.indpred, i.indrelid) ILIKE '%phone_normalized IS NOT NULL%'),
         coalesce((SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'customers_phone_normalized_uidx'),
                  'not created: see the duplicate report at the end of customer_phone_normalize.sql')

  -- ── Step 7: schema/vehicle_verification.sql ────────────────────────
  UNION ALL
  SELECT '7', true, 'applications.vehicle_class_reported column (text, nullable)',
         EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'applications'
                    AND column_name = 'vehicle_class_reported' AND data_type = 'text' AND is_nullable = 'YES'),
         'ALTER TABLE applications ADD COLUMN vehicle_class_reported TEXT'
  UNION ALL
  SELECT '7', true, 'applications.vehicle_class_verified_at column (timestamptz, nullable)',
         EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'applications'
                    AND column_name = 'vehicle_class_verified_at'
                    AND data_type = 'timestamp with time zone' AND is_nullable = 'YES'),
         'ALTER TABLE applications ADD COLUMN vehicle_class_verified_at TIMESTAMPTZ'
  UNION ALL
  SELECT '7', true, 'applications.vehicle_class_verified_by column (text, nullable)',
         EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'applications'
                    AND column_name = 'vehicle_class_verified_by' AND data_type = 'text' AND is_nullable = 'YES'),
         'ALTER TABLE applications ADD COLUMN vehicle_class_verified_by TEXT'


  -- ── Step 8: schema/driver_consents.sql (required for consent records) ──
  UNION ALL
  SELECT '8', true, 'applications.background_check_disclosure_read column (boolean, nullable)',
         EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'applications'
                    AND column_name = 'background_check_disclosure_read' AND data_type = 'boolean' AND is_nullable = 'YES'),
         'ALTER TABLE applications ADD COLUMN IF NOT EXISTS background_check_disclosure_read BOOLEAN (schema/driver_consents.sql)'
  UNION ALL
  SELECT '8', true, 'applications.esignature_consent column (boolean, nullable)',
         EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'applications'
                    AND column_name = 'esignature_consent' AND data_type = 'boolean' AND is_nullable = 'YES'),
         'ALTER TABLE applications ADD COLUMN IF NOT EXISTS esignature_consent BOOLEAN (schema/driver_consents.sql)'
  UNION ALL
  SELECT '8', true, 'applications.terms_consent column (boolean, nullable)',
         EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'applications'
                    AND column_name = 'terms_consent' AND data_type = 'boolean' AND is_nullable = 'YES'),
         'ALTER TABLE applications ADD COLUMN IF NOT EXISTS terms_consent BOOLEAN (schema/driver_consents.sql)'
  UNION ALL
  SELECT '8', true, 'applications.consents_accepted_at column (timestamptz, nullable)',
         EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'applications'
                    AND column_name = 'consents_accepted_at' AND data_type = 'timestamp with time zone' AND is_nullable = 'YES'),
         'ALTER TABLE applications ADD COLUMN IF NOT EXISTS consents_accepted_at TIMESTAMPTZ (schema/driver_consents.sql)'

  -- ── Step 9 (recommended): schema/admin_login_attempts.sql ──────────
  -- Login lockout + per-IP limits. Not REQUIRED: without it those limits are off (fail open).
  UNION ALL
  SELECT '9', false, 'table admin_login_attempts exists',
         to_regclass('public.admin_login_attempts') IS NOT NULL,
         'CREATE TABLE admin_login_attempts (schema/admin_login_attempts.sql)'
  UNION ALL
  SELECT '9', false, 'admin_login_attempts.key column (text, not null)',
         EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'admin_login_attempts'
                    AND column_name = 'key' AND data_type = 'text' AND is_nullable = 'NO'),
         coalesce((SELECT data_type || CASE WHEN is_nullable = 'NO' THEN ' not null' ELSE ' nullable' END || coalesce(' default ' || column_default, '')
                     FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'admin_login_attempts' AND column_name = 'key'), 'column missing')
  UNION ALL
  SELECT '9', false, 'admin_login_attempts.failures column (integer, not null, default 0)',
         EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'admin_login_attempts'
                    AND column_name = 'failures' AND data_type = 'integer' AND is_nullable = 'NO' AND column_default = '0'),
         coalesce((SELECT data_type || CASE WHEN is_nullable = 'NO' THEN ' not null' ELSE ' nullable' END || coalesce(' default ' || column_default, '')
                     FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'admin_login_attempts' AND column_name = 'failures'), 'column missing')
  UNION ALL
  SELECT '9', false, 'admin_login_attempts.first_failed_at column (timestamp with time zone, nullable)',
         EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'admin_login_attempts'
                    AND column_name = 'first_failed_at' AND data_type = 'timestamp with time zone' AND is_nullable = 'YES'),
         coalesce((SELECT data_type || CASE WHEN is_nullable = 'NO' THEN ' not null' ELSE ' nullable' END || coalesce(' default ' || column_default, '')
                     FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'admin_login_attempts' AND column_name = 'first_failed_at'), 'column missing')
  UNION ALL
  SELECT '9', false, 'admin_login_attempts.locked_until column (timestamp with time zone, nullable)',
         EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'admin_login_attempts'
                    AND column_name = 'locked_until' AND data_type = 'timestamp with time zone' AND is_nullable = 'YES'),
         coalesce((SELECT data_type || CASE WHEN is_nullable = 'NO' THEN ' not null' ELSE ' nullable' END || coalesce(' default ' || column_default, '')
                     FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'admin_login_attempts' AND column_name = 'locked_until'), 'column missing')
  UNION ALL
  SELECT '9', false, 'admin_login_attempts.updated_at column (timestamp with time zone, not null, default now())',
         EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'admin_login_attempts'
                    AND column_name = 'updated_at' AND data_type = 'timestamp with time zone' AND is_nullable = 'NO' AND column_default = 'now()'),
         coalesce((SELECT data_type || CASE WHEN is_nullable = 'NO' THEN ' not null' ELSE ' nullable' END || coalesce(' default ' || column_default, '')
                     FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'admin_login_attempts' AND column_name = 'updated_at'), 'column missing')
  UNION ALL
  SELECT '9', false, 'admin_login_attempts_pkey: PRIMARY KEY (key), the only index the code needs (lookups are by key)',
         EXISTS (SELECT 1 FROM pg_index i
                   JOIN pg_class c ON c.oid = i.indexrelid
                  WHERE i.indrelid = to_regclass('public.admin_login_attempts')
                    AND i.indisprimary AND i.indisvalid
                    AND pg_get_indexdef(i.indexrelid) ILIKE '%(key)'),
         coalesce((SELECT string_agg(indexdef, '; ') FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'admin_login_attempts'), 'no indexes (table missing?)')
  UNION ALL
  SELECT '9', false, 'admin_login_attempts has RLS on and no policies (service role only)',
         coalesce((SELECT relrowsecurity FROM pg_class WHERE oid = to_regclass('public.admin_login_attempts')), false)
           AND NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'admin_login_attempts'),
         coalesce((SELECT 'rls = ' || relrowsecurity::text FROM pg_class WHERE oid = to_regclass('public.admin_login_attempts')), 'table missing')
         || ', policies = ' || (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'admin_login_attempts')::text

  -- ── Bucket (deploy block step 6): Storage bucket driver-documents ───
  UNION ALL
  SELECT 'bucket', true, 'storage bucket driver-documents exists',
         EXISTS (SELECT 1 FROM storage.buckets WHERE id = 'driver-documents' OR name = 'driver-documents'),
         'Supabase > Storage > New bucket'
  UNION ALL
  SELECT 'bucket', true, 'driver-documents is private (public = false)',
         EXISTS (SELECT 1 FROM storage.buckets WHERE name = 'driver-documents' AND public IS FALSE),
         coalesce((SELECT 'public = ' || public::text FROM storage.buckets WHERE name = 'driver-documents'), 'bucket missing')
  UNION ALL
  SELECT 'bucket', true, 'driver-documents file size limit = 4 MB (4194304 bytes; 4000000 also accepted)',
         EXISTS (SELECT 1 FROM storage.buckets WHERE name = 'driver-documents' AND file_size_limit IN (4194304, 4000000)),
         coalesce((SELECT 'file_size_limit = ' || coalesce(file_size_limit::text, 'NULL (no limit)') FROM storage.buckets WHERE name = 'driver-documents'), 'bucket missing')
  UNION ALL
  SELECT 'bucket', true, 'driver-documents allowed MIME types = jpeg, png, webp, heic, heif, pdf (exactly)',
         EXISTS (SELECT 1 FROM storage.buckets WHERE name = 'driver-documents'
                    AND allowed_mime_types IS NOT NULL
                    AND allowed_mime_types @> ARRAY['image/jpeg','image/png','image/webp','image/heic','image/heif','application/pdf']::text[]
                    AND allowed_mime_types <@ ARRAY['image/jpeg','image/png','image/webp','image/heic','image/heif','application/pdf']::text[]),
         coalesce((SELECT 'allowed_mime_types = ' || coalesce(array_to_string(allowed_mime_types, ', '), 'NULL (any)') FROM storage.buckets WHERE name = 'driver-documents'), 'bucket missing')
)
SELECT step,
       CASE WHEN required THEN 'REQUIRED' ELSE 'optional' END AS required,
       check_name,
       ok,
       detail
  FROM checks
 ORDER BY CASE step WHEN '5' THEN 1 WHEN '6' THEN 2 WHEN '7' THEN 3 WHEN '8' THEN 4 WHEN '9' THEN 5 ELSE 6 END, check_name;
