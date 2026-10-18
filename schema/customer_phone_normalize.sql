-- OPTIONAL, NOT YET RUN ANYWHERE LIVE. Draft for Tommy to review.
-- customers.phone_normalized: the phone as 10 US digits ("(361) 555-0100",
-- "+1 361-555-0100" and "3615550100" all become "3615550100"). This is the same
-- rule as netlify/functions/_phone.js. Stored customers.phone is never changed.
--
-- Safe to re-run: IF NOT EXISTS / CREATE OR REPLACE / DROP ... IF EXISTS only.
-- Nothing is deleted or merged. Run after schema.sql.
--
-- What it does:
--   1. Adds customers.phone_normalized (TEXT, NULL when the phone is not a
--      10-digit US number).
--   2. Adds a trigger that keeps it in sync on every insert, or update of phone,
--      so create-order does not need to write it.
--   3. Backfills existing rows.
--   4. Adds a plain lookup index.
--   5. Adds a UNIQUE index ONLY if there are no duplicate normalized phones.
--      Otherwise it skips that step with a NOTICE, and you can re-run this file
--      once duplicates are resolved.
--   6. Ends with the read-only duplicate report.
--
-- create-order already uses phone_normalized when it exists, and falls back to
-- matching common phone formats when it does not. Either way, a duplicate
-- phone reuses the oldest customer row instead of failing.
--
-- Rollback:
--   DROP INDEX IF EXISTS customers_phone_normalized_uidx;
--   DROP INDEX IF EXISTS idx_customers_phone_normalized;
--   DROP TRIGGER IF EXISTS customers_phone_normalized_sync ON customers;
--   DROP FUNCTION IF EXISTS customers_phone_normalized_sync();
--   ALTER TABLE customers DROP COLUMN IF EXISTS phone_normalized;
--   DROP FUNCTION IF EXISTS cdd_phone_key(TEXT);

-- 0. PRE-CHECK (read-only). You can paste this SELECT on its own before
--    running anything. It works with or without the new column. It lists every
--    10-digit number shared by more than one customer row, oldest row first,
--    with order counts. Empty result means the unique index will be created.
--    The same query runs again at the end of this file.
--
--    SELECT k AS phone_normalized,
--           count(*) AS customer_rows,
--           array_agg(c.id ORDER BY c.created_at, c.id) AS customer_ids_oldest_first,
--           array_agg(c.phone ORDER BY c.created_at, c.id) AS phones_as_typed,
--           array_agg((SELECT count(*) FROM orders o WHERE o.customer_id = c.id) ORDER BY c.created_at, c.id) AS orders_per_customer
--    FROM customers c
--    CROSS JOIN LATERAL (SELECT CASE
--        WHEN length(regexp_replace(coalesce(c.phone, ''), '\D', '', 'g')) = 11
--         AND left(regexp_replace(c.phone, '\D', '', 'g'), 1) = '1'
--          THEN substr(regexp_replace(c.phone, '\D', '', 'g'), 2)
--        WHEN length(regexp_replace(coalesce(c.phone, ''), '\D', '', 'g')) = 10
--          THEN regexp_replace(c.phone, '\D', '', 'g')
--      END AS k) n
--    WHERE k IS NOT NULL
--    GROUP BY k HAVING count(*) > 1
--    ORDER BY count(*) DESC, k;

-- 1. Normalizer (same rule as _phone.js, but NULL unless exactly 10 digits)
CREATE OR REPLACE FUNCTION cdd_phone_key(p TEXT) RETURNS TEXT
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN length(d) = 11 AND left(d, 1) = '1' THEN substr(d, 2)
    WHEN length(d) = 10 THEN d
  END
  FROM (SELECT regexp_replace(coalesce(p, ''), '\D', '', 'g') AS d) s
$$;

ALTER TABLE customers ADD COLUMN IF NOT EXISTS phone_normalized TEXT;

-- 2. Keep it in sync for every writer
CREATE OR REPLACE FUNCTION customers_phone_normalized_sync() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.phone_normalized := cdd_phone_key(NEW.phone);
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS customers_phone_normalized_sync ON customers;
CREATE TRIGGER customers_phone_normalized_sync
  BEFORE INSERT OR UPDATE OF phone ON customers
  FOR EACH ROW EXECUTE FUNCTION customers_phone_normalized_sync();

-- 3. Backfill (only rows that are missing or stale)
UPDATE customers
   SET phone_normalized = cdd_phone_key(phone)
 WHERE phone_normalized IS DISTINCT FROM cdd_phone_key(phone);

-- 4. Lookup index (non-unique, always safe)
CREATE INDEX IF NOT EXISTS idx_customers_phone_normalized ON customers (phone_normalized);

-- 5. Unique index only once duplicates are gone
DO $$
DECLARE dup_numbers INT;
BEGIN
  SELECT count(*) INTO dup_numbers FROM (
    SELECT phone_normalized FROM customers
     WHERE phone_normalized IS NOT NULL
     GROUP BY phone_normalized HAVING count(*) > 1
  ) d;
  IF dup_numbers = 0 THEN
    CREATE UNIQUE INDEX IF NOT EXISTS customers_phone_normalized_uidx
      ON customers (phone_normalized) WHERE phone_normalized IS NOT NULL;
  ELSE
    RAISE NOTICE 'customers_phone_normalized_uidx NOT created: % phone number(s) belong to more than one customer. See the report below, resolve them (manual decision), then re-run this file.', dup_numbers;
  END IF;
END $$;

-- 6. MANUAL, NOT AUTOMATIC: merging duplicates is Tommy's decision.
--    orders.customer_id is ON DELETE CASCADE, so deleting a customer row
--    before re-pointing its orders would DELETE THOSE ORDERS. Review the
--    report first, and back up first. A suggested merge that keeps the oldest
--    row per number (still commented out; run inside a transaction only after
--    review):
--
--    BEGIN;
--    CREATE TEMP TABLE cdd_dupes ON COMMIT DROP AS
--      SELECT id, first_value(id) OVER (PARTITION BY phone_normalized ORDER BY created_at, id) AS keep_id
--        FROM customers WHERE phone_normalized IS NOT NULL;
--    DELETE FROM cdd_dupes WHERE id = keep_id;
--    UPDATE orders o SET customer_id = d.keep_id FROM cdd_dupes d WHERE o.customer_id = d.id;
--    -- Optional: carry over a missing email or stripe_customer_id onto keep_id here.
--    DELETE FROM customers c USING cdd_dupes d WHERE c.id = d.id
--      AND NOT EXISTS (SELECT 1 FROM orders o WHERE o.customer_id = c.id);
--    COMMIT;
--    -- Then re-run this file to create the unique index.

-- Report (read-only): numbers still shared by more than one customer.
-- Empty result means the unique index exists.
SELECT phone_normalized,
       count(*) AS customer_rows,
       array_agg(id ORDER BY created_at, id) AS customer_ids_oldest_first,
       array_agg(phone ORDER BY created_at, id) AS phones_as_typed
  FROM customers
 WHERE phone_normalized IS NOT NULL
 GROUP BY phone_normalized
HAVING count(*) > 1
 ORDER BY count(*) DESC, phone_normalized;
