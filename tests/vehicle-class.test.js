#!/usr/bin/env node
// Vehicle class: drivers pick a class on the application (stored, self-
// reported); beach (4x4) orders need a 4x4-capable class that an admin has
// verified, in auto-dispatch AND admin assign; the admin control is logged;
// everything still works (as "unverified") before schema/vehicle_verification.sql
// runs. Fake Supabase, Twilio env unset.
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const Module = require("module");
const jwt = require("jsonwebtoken");
const { createFakeSupabase } = require("./helpers/fake-supabase");

let fake = null;
const realLoad = Module._load;
Module._load = function (request) {
  if (request === "@supabase/supabase-js") return { createClient: () => fake };
  if (request === "twilio") throw new Error("twilio must not load in tests");
  return realLoad.apply(this, arguments);
};
const SECRET = "test-vehicle-class-secret-32bytes!!";
process.env.JWT_SECRET = SECRET;
process.env.SUPABASE_URL = "http://example.invalid";
process.env.SUPABASE_SERVICE_KEY = "test";
delete process.env.TWILIO_ACCOUNT_SID; delete process.env.TWILIO_AUTH_TOKEN; delete process.env.TWILIO_PHONE_NUMBER;
delete process.env.WEATHER_SHUTDOWN; delete process.env.COYOTE_WEATHER_HOLD;

const ROOT = path.join(__dirname, "..");
const FN = path.join(ROOT, "netlify/functions");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
const vehicle = require(path.join(FN, "_vehicle.js"));
const admin = require(path.join(FN, "admin.js"));
const dispatch = require(path.join(FN, "dispatch.js"));
const submit = require(path.join(FN, "submit-application.js"));
// Required consents (submit-application rejects an application without them).
const CONSENT = { bgConsent: "true", bgDisclosureRead: "true", esignature: "true", termsAgree: "true" };
const updateApp = require(path.join(FN, "update-application.js"));

const adminToken = jwt.sign({ role: "admin", user: "ops" }, SECRET);
const driverToken = jwt.sign({ role: "driver", driver_id: "d-self" }, SECRET);
const H = (token) => Object.assign({ origin: "https://coyote-dune-delivery.netlify.app" }, token ? { authorization: "Bearer " + token } : {});
const call = (method, p, body, token = adminToken) => admin.handler({ httpMethod: method, path: "/.netlify/functions/admin/" + p, headers: H(token), body: body ? JSON.stringify(body) : null });
const B = (r) => JSON.parse(r.body);
const quiet = async (fn) => { const w = console.warn, l = console.log; console.warn = () => {}; console.log = () => {}; try { return await fn(); } finally { console.warn = w; console.log = l; } };

const PA = [27.8339, -97.0611];
const VER = { vehicle_class_reported: null, vehicle_class_verified_at: null, vehicle_class_verified_by: null };
const drv = (id, cls, over) => Object.assign({ id, first_name: id === "d-self" ? "Sky" : "Val", last_name: "Driver", email: id + "@example.com", phone: null,
  status: "approved", online: true, beach_permit_ok: true, vehicle_class: cls, notes: null }, VER, over);
const beachOrder = (over) => Object.assign({ id: "o-beach", order_number: "CDD-BEACH1", status: "pending", payment_status: "paid", pickup_city: "Port Aransas", dropoff_city: "Mustang Island",
  pickup_lat: PA[0], pickup_lng: PA[1], required_vehicle_class: "4x4", customer_id: "c1", driver_id: null, weather_hold: false }, over);
const townOrder = () => beachOrder({ id: "o-town", order_number: "CDD-TOWN1", pickup_city: "Rockport", dropoff_city: "Rockport", required_vehicle_class: "2wd" });
const seed = (apps, orders) => ({ applications: apps, orders: orders || [beachOrder(), townOrder()], driver_locations: apps.map((a) => ({ driver_id: a.id, lat: PA[0], lng: PA[1], timestamp: "2026-10-18T12:00:00Z" })),
  dispatch_offers: [], order_status_logs: [], sms_logs: [], customers: [{ id: "c1", phone: null }] });

/** Like the real DB before schema/vehicle_verification.sql: those columns don't exist. */
function withoutVehicleColumns(base) {
  const cols = vehicle.NEW_COLS;
  const from = (name) => {
    const b = base.from(name);
    if (name !== "applications") return b;
    let bad = null;
    const strip = (rows) => (Array.isArray(rows) ? rows : [rows]).forEach((r) => r && cols.forEach((c) => delete r[c]));
    const wrap = new Proxy(b, { get(t, k) {
      if (k === "then") return (res, rej) => bad
        ? res({ data: null, error: bad.op === "select" ? { code: "42703", message: `column applications.${bad.col} does not exist` }
          : { code: "PGRST204", message: `Could not find the '${bad.col}' column of 'applications' in the schema cache` } })
        : t.then((r) => { if (r.data) strip(r.data); res(r); }, rej);
      const v = t[k];
      if (typeof v !== "function") return v;
      return (...args) => {
        if (k === "select" && typeof args[0] === "string") { const c = cols.find((x) => args[0].includes(x)); if (c) bad = { op: "select", col: c }; }
        if (k === "insert" || k === "update") { const rows = [].concat(args[0]); const c = cols.find((x) => rows.some((r) => r && x in r)); if (c) bad = { op: k, col: c }; }
        v.apply(t, args); return wrap;
      };
    } });
    return wrap;
  };
  return { from, db: base.db, calls: base.calls };
}
const fresh = (apps, orders) => { fake = createFakeSupabase(seed(apps, orders)); return fake; };
const freshNoColumns = (apps, orders) => {
  const base = createFakeSupabase(seed(apps.map((a) => { const r = Object.assign({}, a); vehicle.NEW_COLS.forEach((c) => delete r[c]); return r; }), orders));
  fake = withoutVehicleColumns(base); return fake;
};
const app = (id) => fake.db.applications.find((a) => a.id === id);
const order = (id) => fake.db.orders.find((o) => o.id === id);

const tests = [];
const test = (n, f) => tests.push([n, f]);

// ── shared rule ──
test("rule: 4x4 orders need a 4x4-capable class AND a verification; 2wd orders take anyone", () => {
  assert.deepStrictEqual(vehicle.VEHICLE_CLASSES, ["2wd", "awd", "4x4", "utv"]);
  const v = { vehicle_class_verified_at: "2026-10-18T20:00:00Z" };
  for (const c of ["4x4", "awd", "utv"]) {
    assert.strictEqual(vehicle.vehicleCheck("4x4", Object.assign({ vehicle_class: c }, v)).ok, true, c);
    assert.strictEqual(vehicle.vehicleCheck("4x4", { vehicle_class: c }).code, "unverified", c);
  }
  assert.strictEqual(vehicle.vehicleCheck("4x4", Object.assign({ vehicle_class: "2wd" }, v)).code, "class");
  assert.strictEqual(vehicle.vehicleCheck("4x4", { vehicle_class: null }).code, "class");
  for (const c of ["2wd", "4x4", null]) assert.strictEqual(vehicle.vehicleCheck("2wd", { vehicle_class: c }).ok, true);
  // every class name the dispatch side uses is one the form offers
  const zones = read("netlify/functions/zones.js");
  assert(/"4x4"/.test(zones) && /"2wd"/.test(zones));
});

test("both auto-dispatch and admin assign use _vehicle.js (no local class list left)", () => {
  for (const f of ["netlify/functions/dispatch.js", "netlify/functions/_order-admin.js"]) {
    const s = read(f);
    assert(/require\("\.\/_vehicle"\)/.test(s) && /vehicleCheck\(/.test(s), f);
    assert(!/BEACH_CLASSES|"4x4", "utv", "awd"/.test(s), f + " has its own class list");
  }
});

// ── application form ──
test("apply form: required vehicle type select with the dispatch class values, plain labels and beach help text", () => {
  const html = read("frontend/apply/index.html");
  const m = /<select id="vehicleClass" name="vehicleClass" required aria-describedby="vehicleClassHelp">([\s\S]*?)<\/select>/.exec(html);
  assert(m, "required select#vehicleClass described by the help text");
  const opts = [...m[1].matchAll(/<option value="([^"]*)"[^>]*>([^<]+)<\/option>/g)].map((x) => [x[1], x[2]]);
  assert.deepStrictEqual(opts.slice(1).map((o) => o[0]), vehicle.VEHICLE_CLASSES);
  opts.slice(1).forEach(([v, t]) => assert.strictEqual(t, vehicle.LABELS[v], "label for " + v + " matches _vehicle.LABELS"));
  assert.strictEqual(opts[0][0], "", "placeholder has no value, so nothing is pre-chosen");
  const help = /<p class="form-hint" id="vehicleClassHelp">([^<]+)<\/p>/.exec(html);
  assert(help && /Beach/.test(help[1]) && /4x4/.test(help[1]) && /check your vehicle/.test(help[1]), "help says beach needs 4x4 and that we check it");
  const js = read("frontend/js/apply.js");
  assert(/vehicleClass: \(v\) => \['2wd', 'awd', '4x4', 'utv'\]\.includes\(v\)/.test(js), "client validator");
  assert(/'vehicleColor', 'vehicleClass', 'licensePlate'/.test(js), "shown on the review step");
});

test("submit-application: vehicle class required + valid; stored as self-reported, never verified", async () => {
  fresh([]);
  const base = { first_name: "New", last_name: "Driver", email: "new@example.com", phone: "5555550199" };
  const post = (b) => quiet(() => submit.handler({ httpMethod: "POST", headers: H(null), body: JSON.stringify(Object.assign({}, CONSENT, b)) }));
  for (const bad of [undefined, "", "truck", "4wd"]) {
    const r = await post(Object.assign({}, base, bad === undefined ? {} : { vehicleClass: bad }));
    assert.strictEqual(r.statusCode, 400, String(bad));
    assert.strictEqual(B(r).field, "vehicleClass");
  }
  assert.strictEqual(fake.db.applications.length, 0, "nothing saved without a valid class");
  const r = await post(Object.assign({}, base, { vehicleClass: " 4X4 ", vehicle_class_verified_at: "2026-01-01", vehicle_class_verified_by: "me" }));
  assert.strictEqual(r.statusCode, 201, r.body);
  const row = fake.db.applications[0];
  assert.deepStrictEqual([row.vehicle_class, row.vehicle_class_reported, row.status], ["4x4", "4x4", "pending"]);
  assert(!("vehicle_class_verified_at" in row) && !("vehicle_class_verified_by" in row), "applicant can't verify themselves");
});

test("submit-application before the SQL runs: saved without vehicle_class_reported (class kept in vehicle_class)", async () => {
  freshNoColumns([]);
  const r = await quiet(() => submit.handler({ httpMethod: "POST", headers: H(null), body: JSON.stringify(Object.assign({ first_name: "A", email: "a@example.com", vehicleClass: "utv" }, CONSENT)) }));
  assert.strictEqual(r.statusCode, 201, r.body);
  const row = fake.db.applications[0];
  assert.strictEqual(row.vehicle_class, "utv");
  assert(!("vehicle_class_reported" in row));
});

// ── self-reported 4x4 is not enough ──
test("auto-dispatch: an approved, online, self-reported (unverified) 4x4 gets no beach offer; logged with a pointer", async () => {
  fresh([drv("d-self", "4x4", { vehicle_class_reported: "4x4" })]);
  const r = await dispatch.offerNext(fake, "o-beach");
  assert.deepStrictEqual([r.offered, r.reason, r.unverified], [false, "no_drivers", 1]);
  assert.strictEqual(fake.db.dispatch_offers.length, 0);
  const note = fake.db.order_status_logs[0].note;
  assert(/^No online 4x4 driver available\. Holding for dispatch\./.test(note), "keeps the text the admin 'no driver' flag matches");
  assert(/isn't verified yet; verify it in Admin > Applications/.test(note), note);
  // the same driver still gets mainland orders
  const t = await dispatch.offerNext(fake, "o-town");
  assert.deepStrictEqual([t.offered, t.driverId], [true, "d-self"]);
});

test("admin assign: unverified 4x4 refused (422 vehicle_unverified), order unchanged; GET /orders shows it disabled with the reason", async () => {
  fresh([drv("d-self", "4x4"), drv("d-ok", "4x4", { vehicle_class_verified_at: "2026-10-18T20:00:00Z", vehicle_class_verified_by: "ops" })]);
  const r = await quiet(() => call("PUT", "orders/o-beach", { driver_id: "d-self" }));
  assert.strictEqual(r.statusCode, 422, r.body);
  assert.strictEqual(B(r).code, "vehicle_unverified");
  assert(/needs a verified 4x4; Sky D\.'s 4x4 isn't verified yet\. Verify it in Applications first\./.test(B(r).error), B(r).error);
  assert.deepStrictEqual([order("o-beach").status, order("o-beach").driver_id], ["pending", null]);
  assert.strictEqual(fake.db.order_status_logs.length, 0);

  const list = B(await quiet(() => call("GET", "orders")));
  assert.strictEqual(list.vehicleSetupMessage, null);
  const opts = list.orders.find((o) => o.id === "o-beach").driver_options;
  const self = opts.find((d) => d.id === "d-self"), ok = opts.find((d) => d.id === "d-ok");
  assert.deepStrictEqual([self.eligible, self.vehicle_verified, self.reason], [false, false, "needs a verified 4x4; 4x4 not verified yet"]);
  assert.deepStrictEqual([ok.eligible, ok.vehicle_verified], [true, true]);
  assert.strictEqual(list.orders.find((o) => o.id === "o-town").driver_options.find((d) => d.id === "d-self").eligible, true);
  const drivers = B(await quiet(() => call("GET", "drivers"))).drivers;
  assert.strictEqual(drivers.find((d) => d.id === "d-self").vehicle_verified, false);
  // a verified driver goes through
  const a = await quiet(() => call("PUT", "orders/o-beach", { driver_id: "d-ok" }));
  assert.strictEqual(a.statusCode, 200, a.body);
});

// ── the admin control ──
test("PUT /applications/:id/vehicle: admin only, validates input, nothing written on bad input", async () => {
  fresh([drv("d-self", "2wd", { vehicle_class_reported: "2wd" })]);
  const before = JSON.stringify(fake.db.applications);
  assert.strictEqual((await call("PUT", "applications/d-self/vehicle", { vehicle_class: "4x4", verified: true }, null)).statusCode, 401);
  assert.strictEqual((await call("PUT", "applications/d-self/vehicle", { vehicle_class: "4x4", verified: true }, driverToken)).statusCode, 403);
  assert.strictEqual((await call("PUT", "applications/d-self/vehicle", { vehicle_class: "tank", verified: true })).statusCode, 400);
  assert.strictEqual((await call("PUT", "applications/d-self/vehicle", { vehicle_class: "4x4" })).statusCode, 400, "verified must be said explicitly");
  assert.strictEqual((await call("PUT", "applications/d-self/vehicle", { vehicle_class: "4x4", verified: "yes" })).statusCode, 400);
  assert.strictEqual((await call("PUT", "applications/nope/vehicle", { vehicle_class: "4x4", verified: true })).statusCode, 404);
  assert.strictEqual(JSON.stringify(fake.db.applications), before);
  // the general application PUT still can't touch vehicle fields
  const { patch } = admin._internal.buildApplicationPatch({ status: "approved", vehicle_class: "4x4", vehicle_class_verified_at: "x" });
  assert.deepStrictEqual(Object.keys(patch).sort(), ["status", "updated_at"]);
});

test("verify: sets class + verified_at/by, logs a dated line in notes; then dispatch AND assign accept the driver; un-verify blocks again", async () => {
  fresh([drv("d-self", "2wd", { vehicle_class_reported: "2wd", notes: "Called 10/17." })]);
  const r = await quiet(() => call("PUT", "applications/d-self/vehicle", { vehicle_class: "4x4", verified: true }));
  assert.strictEqual(r.statusCode, 200, r.body);
  const a = app("d-self");
  assert.deepStrictEqual([a.vehicle_class, a.vehicle_class_verified_by, a.vehicle_class_reported], ["4x4", "ops", "2wd"]);
  assert(!isNaN(Date.parse(a.vehicle_class_verified_at)));
  assert(/^Called 10\/17\.\n\[.+ CT\] Vehicle class 2wd → 4x4, verified by admin ops \(driver reported 2wd\)\.$/.test(a.notes), a.notes);
  const shaped = B(r).data;
  assert.deepStrictEqual([shaped.vehicle_verified, shaped.vehicle_verification_ready, shaped.vehicle_class_label], [true, true, vehicle.LABELS["4x4"]]);
  assert.strictEqual(shaped.admin_notes, a.notes, "dashboard gets the notes with the log line");

  const off = await dispatch.offerNext(fake, "o-beach");
  assert.deepStrictEqual([off.offered, off.driverId], [true, "d-self"]);
  fake.db.dispatch_offers = []; // clear the auto-offer so admin can assign
  const as = await quiet(() => call("PUT", "orders/o-beach", { driver_id: "d-self" }));
  assert.strictEqual(as.statusCode, 200, as.body);

  // marking it not verified clears who/when, keeps the class, logs again
  await quiet(() => call("PUT", "orders/o-beach", { status: "pending" }));
  const u = await quiet(() => call("PUT", "applications/d-self/vehicle", { vehicle_class: "4x4", verified: false }));
  assert.strictEqual(u.statusCode, 200, u.body);
  assert.deepStrictEqual([app("d-self").vehicle_class_verified_at, app("d-self").vehicle_class_verified_by, app("d-self").vehicle_class], [null, null, "4x4"]);
  assert(/Vehicle class 4x4 → 4x4, marked not verified by admin ops/.test(app("d-self").notes));
  assert.strictEqual((await quiet(() => call("PUT", "orders/o-beach", { driver_id: "d-self" }))).statusCode, 422);
});

test("GET /applications: class, self-report and verification state for the dashboard", async () => {
  fresh([drv("d-self", "awd", { vehicle_class_reported: "awd" })]);
  const b = B(await call("GET", "applications"));
  assert.strictEqual(b.vehicleSetupMessage, null);
  const a = b.applications[0];
  assert.deepStrictEqual([a.vehicle_class, a.vehicle_class_reported, a.vehicle_verified, a.vehicle_verification_ready], ["awd", "awd", false, true]);
});

// ── before schema/vehicle_verification.sql ──
test("columns missing: everyone unverified, beach waits with a clear message, mainland works, verify refused with nothing written", async () => {
  freshNoColumns([drv("d-self", "4x4")]);
  const off = await quiet(() => dispatch.offerNext(fake, "o-beach"));
  assert.deepStrictEqual([off.offered, off.reason], [false, "no_drivers"]);
  assert(fake.db.order_status_logs[0].note.includes(vehicle.SETUP_MESSAGE), "log says to run the SQL");
  assert.strictEqual((await quiet(() => dispatch.offerNext(fake, "o-town"))).offered, true, "mainland dispatch unaffected");
  fake.db.dispatch_offers = [];

  const as = await quiet(() => call("PUT", "orders/o-beach", { driver_id: "d-self" }));
  assert.strictEqual(as.statusCode, 422);
  assert.strictEqual(B(as).code, "vehicle_unverified");
  assert(B(as).error.includes("schema/vehicle_verification.sql"), B(as).error);

  const list = await quiet(() => call("GET", "orders"));
  assert.strictEqual(list.statusCode, 200);
  assert.strictEqual(B(list).vehicleSetupMessage, vehicle.SETUP_MESSAGE);
  assert.strictEqual(B(await quiet(() => call("GET", "drivers"))).vehicleSetupMessage, vehicle.SETUP_MESSAGE);
  const apps = B(await call("GET", "applications"));
  assert.strictEqual(apps.vehicleSetupMessage, vehicle.SETUP_MESSAGE);
  assert.strictEqual(apps.applications[0].vehicle_verification_ready, false);

  const before = JSON.stringify(fake.db.applications);
  const v = await quiet(() => call("PUT", "applications/d-self/vehicle", { vehicle_class: "4x4", verified: true }));
  assert.strictEqual(v.statusCode, 409);
  assert.strictEqual(B(v).code, "vehicle_columns_missing");
  assert(/Nothing was saved/.test(B(v).error));
  assert.strictEqual(JSON.stringify(fake.db.applications), before);
});

// ── driver edits their vehicle ──
test("driver portal: changing make/model/year/plate clears verification (logged); other edits keep it", async () => {
  const verified = { vehicle_make: "Jeep", vehicle_model: "Wrangler", vehicle_year: 2020, license_plate: "ABC123", vehicle_class_verified_at: "2026-10-18T20:00:00Z", vehicle_class_verified_by: "ops" };
  fresh([drv("d-self", "4x4", verified)]);
  const put = (b) => quiet(() => updateApp.handler({ httpMethod: "PUT", path: "/api/update-application/d-self", queryStringParameters: { applicantId: "d-self" }, headers: H(null), body: JSON.stringify(Object.assign({ email: "d-self@example.com" }, b)) }));
  let r = await put({ phone: "5555550123", vehicle_make: "jeep ", vehicle_model: "Wrangler", vehicle_year: "2020", vehicle_plate: "ABC123" });
  assert.strictEqual(r.statusCode, 200, r.body);
  assert.strictEqual(app("d-self").vehicle_class_verified_by, "ops", "same vehicle: still verified");
  r = await put({ vehicle_model: "Compass" });
  assert.strictEqual(r.statusCode, 200, r.body);
  assert.deepStrictEqual([app("d-self").vehicle_class_verified_at, app("d-self").vehicle_class_verified_by], [null, null]);
  assert(/Driver changed vehicle details; vehicle class verification cleared\./.test(app("d-self").notes));
  assert.strictEqual(app("d-self").vehicle_class, "4x4", "self-reported class stays");
  assert.strictEqual((await dispatch.offerNext(fake, "o-beach")).offered, false);
});

// ── SQL + docs + UI ──
test("draft SQL is re-runnable and only adds nullable columns (nobody marked verified)", () => {
  const sql = read("schema/vehicle_verification.sql");
  const code = sql.split("\n").filter((l) => !/^\s*--/.test(l)).join("\n");
  const alters = code.match(/ALTER TABLE[^;]+;/gi) || [];
  assert.strictEqual(alters.length, 3);
  alters.forEach((a) => assert(/ADD COLUMN IF NOT EXISTS vehicle_class_(reported TEXT|verified_at TIMESTAMPTZ|verified_by TEXT);$/.test(a), a));
  assert(!/\b(UPDATE|DELETE|DROP|INSERT|TRUNCATE)\b|NOT NULL|DEFAULT/i.test(code), "no data changes, no defaults");
  vehicle.NEW_COLS.forEach((c) => assert(code.includes(c)));
});

test("LAUNCH.md: run-order step 7 + Step 7 section; smoke test uses the admin control, not the Table Editor", () => {
  const md = read("LAUNCH.md");
  assert(/^7\. .*`schema\/vehicle_verification\.sql`/m.test(md));
  assert(/### Step 7 on Supabase: `vehicle_verification\.sql`/.test(md));
  const smoke = md.slice(md.indexOf("## Post-deploy smoke test"));
  const before = /\*\*Before you start:\*\*[^\n]+/.exec(smoke)[0];
  assert(!/Table Editor/.test(before), "no Table Editor step left");
  assert(/Vehicle Class \(dispatch\)/.test(before) && /Save & mark verified/.test(before));
  assert(/needs a verified 4x4/.test(smoke));
});

test("admin UI: vehicle panel calls the endpoint, labels match, setup message shown, button text quoted in LAUNCH exists", () => {
  const ui = read("frontend/admin/admin.js");
  assert(/api\('PUT', `\/applications\/\$\{id\}\/vehicle`, \{ vehicle_class: sel\.value, verified \}\)/.test(ui));
  for (const [k, v] of Object.entries(vehicle.LABELS)) assert(ui.includes(`${/^\d/.test(k) ? `'${k}'` : k}: '${v}'`), "label " + k);
  assert(ui.includes("Vehicle Class (dispatch)") && ui.includes("Save &amp; mark verified") && ui.includes("schema/vehicle_verification.sql"));
  assert(/data\.vehicleSetupMessage/.test(ui), "orders list surfaces the setup message");
  assert(/\(verified\)' : ' \(unverified\)'/.test(ui), "assign select says verified/unverified");
});

(async () => {
  let failed = 0;
  for (const [n, f] of tests) {
    try { await f(); console.log("ok -", n); } catch (e) { failed++; console.error("not ok -", n, "\n ", e.stack); }
  }
  console.log(failed ? `${failed} failed` : `vehicle-class: ${tests.length} passed`);
  process.exit(failed ? 1 : 0);
})();
