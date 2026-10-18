-- One order per checkout attempt: create-order dedupes on orders.idempotency_key.
-- Safe to re-run. Run after schema/issue_13_constraints.sql.
-- Rollback: DROP INDEX IF EXISTS orders_idempotency_key_uidx;
--           ALTER TABLE orders DROP COLUMN IF EXISTS idempotency_key;

ALTER TABLE orders ADD COLUMN IF NOT EXISTS idempotency_key TEXT;

-- Unique only when set, so old rows (NULL) and callers that send no key are unaffected.
CREATE UNIQUE INDEX IF NOT EXISTS orders_idempotency_key_uidx
    ON orders (idempotency_key)
    WHERE idempotency_key IS NOT NULL;
