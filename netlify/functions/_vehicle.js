/**
 * Vehicle class rules shared by auto-dispatch (dispatch.js offerNext) and
 * dispatcher assign (_order-admin.js), so both answer the same question the
 * same way: can this driver take an order that needs this class?
 *
 *   - Classes are the ones zones.requiredClass() and orders.required_vehicle_class
 *     use: 2wd, awd, 4x4, utv.
 *   - "4x4" orders (beach / island) need a 4x4-capable class (4x4, utv, awd)
 *     AND an admin check (applications.vehicle_class_verified_at). What a driver
 *     picked on the application form is stored, but never counts on its own.
 *   - 2wd orders: any class.
 *
 * The verified_* columns come from schema/vehicle_verification.sql. Until that
 * runs they don't exist; readers retry without them and every driver counts as
 * unverified (beach orders then need a verified driver, so none qualify), and
 * the admin screen says why.
 */
"use strict";

const VEHICLE_CLASSES = ["2wd", "awd", "4x4", "utv"];
const BEACH_CLASSES = ["4x4", "utv", "awd"];
const LABELS = {
  "2wd": "Regular car, truck or van (2-wheel drive)",
  awd: "All-wheel drive (AWD) car or SUV",
  "4x4": "4x4 truck or SUV (4-wheel drive)",
  utv: "UTV / side-by-side",
};
const VERIFY_COLS = ["vehicle_class_verified_at", "vehicle_class_verified_by"];
const REPORTED_COL = "vehicle_class_reported";
const NEW_COLS = [REPORTED_COL].concat(VERIFY_COLS);
const SETUP_MESSAGE = "Vehicle verification needs a one-time database update: run schema/vehicle_verification.sql "
  + "(LAUNCH.md, SQL run order step 7). Until then no driver counts as verified for beach (4x4) orders.";

function normalizeClass(v) {
  const s = String(v == null ? "" : v).trim().toLowerCase();
  return VEHICLE_CLASSES.includes(s) ? s : null;
}

function classOf(d) { return normalizeClass(d && d.vehicle_class) || "2wd"; }
function isVerified(d) { return !!(d && d.vehicle_class_verified_at); }

/** { ok, code, reason } for a driver row against an order's required class. */
function vehicleCheck(need, d) {
  if (need !== "4x4") return { ok: true, code: null, reason: null };
  const cls = classOf(d);
  if (!BEACH_CLASSES.includes(cls)) return { ok: false, code: "class", reason: `needs ${need}; drives ${cls}` };
  if (!isVerified(d)) return { ok: false, code: "unverified", reason: `needs a verified ${need}; ${cls} not verified yet` };
  return { ok: true, code: null, reason: null };
}

/** PostgREST / Postgres "that column isn't there" for one of our new columns. */
function isMissingVehicleColumn(err) {
  if (!err) return false;
  const text = [err.message, err.details, err.hint].filter(Boolean).join(" ");
  const missing = err.code === "42703" || err.code === "PGRST204" || /does not exist|could not find/i.test(text);
  return missing && /vehicle_class_(verified|reported)/.test(text);
}

/**
 * Run a select that wants the verify columns; if they aren't there yet, run it
 * again without them. run(cols) must return a Supabase query (thenable).
 * Resolves { data, error, verificationReady }.
 */
async function selectWithVerification(run, baseCols, where) {
  const first = await run(baseCols + ", " + VERIFY_COLS.join(", "));
  if (!first.error || !isMissingVehicleColumn(first.error)) return Object.assign({ verificationReady: true }, first);
  console.warn(`[${where || "vehicle"}] applications.vehicle_class_verified_* missing; treating every driver as unverified. ${SETUP_MESSAGE}`);
  const again = await run(baseCols);
  return Object.assign({ verificationReady: false }, again);
}

module.exports = {
  VEHICLE_CLASSES, BEACH_CLASSES, LABELS, VERIFY_COLS, REPORTED_COL, NEW_COLS, SETUP_MESSAGE,
  normalizeClass, classOf, isVerified, vehicleCheck, isMissingVehicleColumn, selectWithVerification,
};
