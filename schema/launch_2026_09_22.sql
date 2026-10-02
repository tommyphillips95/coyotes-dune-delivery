-- Launch hygiene. Run in Supabase SQL editor AFTER a backup.
-- Does not collect SSN or bank numbers going forward. Checkr + Stripe Connect hold that data.

ALTER TABLE applications DROP COLUMN IF EXISTS ssn;
ALTER TABLE applications DROP COLUMN IF EXISTS bank_name;
ALTER TABLE applications DROP COLUMN IF EXISTS bank_account_name;
ALTER TABLE applications DROP COLUMN IF EXISTS bank_account_number;
ALTER TABLE applications DROP COLUMN IF EXISTS bank_routing_number;

ALTER TABLE applications ADD COLUMN IF NOT EXISTS vehicle_class TEXT DEFAULT '2wd';
ALTER TABLE applications ADD COLUMN IF NOT EXISTS online BOOLEAN DEFAULT FALSE;

ALTER TABLE orders ADD COLUMN IF NOT EXISTS required_vehicle_class TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS weather_hold BOOLEAN DEFAULT FALSE;

-- Drop the placeholder admin hash. Set ADMIN_USERNAME / ADMIN_PASSWORD in Netlify env only.
DELETE FROM admin_users WHERE username = 'admin';

DROP POLICY IF EXISTS "Public can insert driver locations" ON driver_locations;
CREATE POLICY "Service role inserts driver locations"
ON driver_locations FOR INSERT
WITH CHECK (false);

DROP POLICY IF EXISTS "Public can view driver locations" ON driver_locations;
CREATE POLICY "Public can view latest driver locations"
ON driver_locations FOR SELECT
USING (true);
