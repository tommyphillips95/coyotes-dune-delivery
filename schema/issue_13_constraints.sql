-- Issue #13: beach access / permit flags + last GPS heartbeat for offline-tolerant ping.
-- Run after schema.sql + launch_2026_09_22.sql + dispatch_offers.sql. Idempotent.

ALTER TABLE applications ADD COLUMN IF NOT EXISTS beach_permit_ok BOOLEAN DEFAULT FALSE;
ALTER TABLE applications ADD COLUMN IF NOT EXISTS beach_access_notes TEXT;
ALTER TABLE applications ADD COLUMN IF NOT EXISTS last_location_at TIMESTAMPTZ;

COMMENT ON COLUMN applications.beach_permit_ok IS 'Driver has a current beach / dune access permit when required';
COMMENT ON COLUMN applications.beach_access_notes IS 'Admin notes on permit / beach access';
COMMENT ON COLUMN applications.last_location_at IS 'Last successful GPS or online heartbeat from update-driver-location';
