-- Vehicle class verification (draft; NOT run anywhere yet).
-- LAUNCH.md, SQL run order step 7.
--
-- Adds three nullable columns to applications. Re-runnable: every statement
-- is IF NOT EXISTS, so a second run changes nothing. No data is changed or
-- deleted, and no driver is marked verified by this script.
--
--   vehicle_class_reported     what the driver picked on the application form
--   vehicle_class_verified_at  when an admin checked the vehicle (NULL = not verified)
--   vehicle_class_verified_by  which admin checked it
--
-- After this runs, beach (4x4) orders only go to drivers whose 4x4/AWD/UTV
-- class has been verified in Admin > Applications > (driver) > Vehicle Class.
-- Before it runs, the app already treats every driver as unverified.

ALTER TABLE applications ADD COLUMN IF NOT EXISTS vehicle_class_reported TEXT;
ALTER TABLE applications ADD COLUMN IF NOT EXISTS vehicle_class_verified_at TIMESTAMPTZ;
ALTER TABLE applications ADD COLUMN IF NOT EXISTS vehicle_class_verified_by TEXT;

-- Read-only check (safe to run any time): approved drivers and their state.
SELECT id, first_name, last_name, status, vehicle_class, vehicle_class_reported,
       vehicle_class_verified_at, vehicle_class_verified_by
FROM applications
WHERE status = 'approved'
ORDER BY vehicle_class_verified_at NULLS FIRST, last_name;
