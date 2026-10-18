#!/usr/bin/env node
// Server-side town + ZIP checks in create-order (netlify/functions/_service-area.js)
// and client/server town-list parity. No network; Supabase is the in-memory fake.
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const Module = require("module");
const { createFakeSupabase } = require("./helpers/fake-supabase");

const root = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");
for (const k of ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_PHONE_NUMBER", "WEATHER_SHUTDOWN", "COYOTE_WEATHER_HOLD"]) delete process.env[k];
process.env.SUPABASE_URL = "http://example.invalid";
process.env.SUPABASE_SERVICE_KEY = "test";
process.env.SITE_ORIGIN = "https://coyote-dune-delivery.netlify.app";
process.env.JWT_SECRET = "test-secret-at-least-16";
let fake = null;
const realLoad = Module._load;
Module._load = function (request) {
  if (request === "@supabase/supabase-js") return { createClient: () => fake };
  return realLoad.apply(this, arguments);
};
const createOrder = require(path.join(root, "netlify/functions/create-order.js"));
const { priceQuote, ZONES } = require(path.join(root, "netlify/functions/zones.js"));
const C = require(path.join(root, "frontend/js/coastal.js"));
const clientZones = require(path.join(root, "frontend/js/zones.js")).ZONES;

const base = (o) => Object.assign({ first_name: "Test", last_name: "Customer", phone: "3615550100", service_type: "ride", passenger_count: 1,
  pickup_address: "1 Beach Access Rd", pickup_city: "Port Aransas", pickup_zip: "78373",
  dropoff_address: "Pin 12", dropoff_city: "Mustang Island", dropoff_zip: "78373" }, o || {});
async function post(b) {
  fake = createFakeSupabase({ customers: [], orders: [], order_status_logs: [], sms_logs: [] });
  const r = await createOrder.handler({ httpMethod: "POST", headers: { origin: process.env.SITE_ORIGIN }, body: JSON.stringify(b) });
  return { status: r.statusCode, body: JSON.parse(r.body), db: fake.db };
}
const tests = [];
const test = (n, f) => tests.push([n, f]);

test("unknown town -> 400 unknown_town, nothing written", async () => {
  for (const o of [{ pickup_city: "Houston" }, { dropoff_city: "North Padre Island" }, { pickup_city: "port aransas" }]) {
    const r = await post(base(o));
    assert.strictEqual(r.status, 400, JSON.stringify(o));
    assert.strictEqual(r.body.code, "unknown_town");
    assert(/Choose a (pickup|drop-off) town: Port Aransas, Mustang Island, Padre Island, Corpus Christi or Rockport/.test(r.body.error), r.body.error);
    assert.strictEqual(r.db.orders.length, 0);
  }
});

test("ZIP outside the Coastal Bend -> 400 zip_outside_area", async () => {
  const r = await post(base({ pickup_zip: "77002" }));
  assert.strictEqual(r.status, 400); assert.strictEqual(r.body.code, "zip_outside_area"); assert.strictEqual(r.body.field, "pickup_zip");
  assert.strictEqual(r.db.orders.length, 0);
});

test("island-only ZIP with a mainland town -> 400 zip_town_mismatch (no silent re-price)", async () => {
  const r = await post(base({ pickup_city: "Corpus Christi", pickup_zip: "78373", dropoff_city: "Corpus Christi", dropoff_zip: "78401" }));
  assert.strictEqual(r.status, 400); assert.strictEqual(r.body.code, "zip_town_mismatch"); assert.strictEqual(r.body.field, "pickup_city");
  assert(/pick Port Aransas or Mustang Island/.test(r.body.error));
  const d = await post(base({ dropoff_city: "Rockport", dropoff_zip: "78373", pickup_city: "Rockport", pickup_zip: "78382" }));
  assert.strictEqual(d.status, 400); assert.strictEqual(d.body.field, "dropoff_city");
});

test("ambiguous 78418 with Corpus Christi: accepted at the quoted price, 4x4 + dispatch note", async () => {
  const r = await post(base({ pickup_city: "Corpus Christi", pickup_zip: "78418", dropoff_city: "Corpus Christi", dropoff_zip: "78418" }));
  assert.strictEqual(r.status, 201, JSON.stringify(r.body));
  const row = r.db.orders[0];
  assert.strictEqual(row.estimated_price, priceQuote("Corpus Christi", "Corpus Christi", { service_type: "ride", passenger_count: 1 }).total);
  assert.strictEqual(row.required_vehicle_class, "4x4");
  assert.strictEqual(r.body.requiredClass, "4x4");
  assert(/Address check: .*78418 covers Flour Bluff/.test(r.db.order_status_logs[0].note), r.db.order_status_logs[0].note);
});

test("legit orders unchanged: beach towns with their ZIPs, CC, Rockport, ZIP+4, no ZIP", async () => {
  for (const o of [{}, { pickup_city: "Padre Island", pickup_zip: "78418", dropoff_city: "Padre Island", dropoff_zip: "78418" },
    { pickup_city: "Corpus Christi", pickup_zip: "78411", dropoff_city: "Corpus Christi", dropoff_zip: "78404" },
    { pickup_city: "Rockport", pickup_zip: "78382", dropoff_city: "Rockport", dropoff_zip: "78382-1234" },
    { pickup_zip: null, dropoff_zip: null }]) {
    const r = await post(base(o));
    assert.strictEqual(r.status, 201, JSON.stringify(o) + " " + JSON.stringify(r.body));
    assert(!/Address check/.test(r.db.order_status_logs[0].note), JSON.stringify(o));
  }
  const cc = await post(base({ pickup_city: "Corpus Christi", pickup_zip: "78411", dropoff_city: "Corpus Christi", dropoff_zip: "78404" }));
  assert.strictEqual(cc.db.orders[0].required_vehicle_class, "2wd");
});

test("region ZIP we haven't mapped (e.g. Fulton 78358): accepted, flagged for dispatch", async () => {
  const r = await post(base({ pickup_city: "Rockport", pickup_zip: "78358", dropoff_city: "Rockport", dropoff_zip: "78382" }));
  assert.strictEqual(r.status, 201);
  assert(/Address check: .*78358 isn't mapped/.test(r.db.order_status_logs[0].note));
});

test("one town list: server zones = coastal CITIES = client zones = /order/ selects", () => {
  const server = Object.keys(ZONES.hubs).sort();
  assert.deepStrictEqual(C.CITIES.slice().sort(), server);
  assert.deepStrictEqual(clientZones.hubs.map((h) => h.name).sort(), server);
  const html = read("frontend/order/index.html");
  for (const id of ["pickupCity", "dropoffCity"]) {
    const sel = html.slice(html.indexOf(`<select id="${id}"`), html.indexOf("</select>", html.indexOf(`<select id="${id}"`)));
    const opts = [...sel.matchAll(/<option value="([^"]+)">/g)].map((m) => m[1]).sort();
    assert.deepStrictEqual(opts, server, id);
  }
  const { ZIP_TOWNS, TOWNS } = require(path.join(root, "netlify/functions/_service-area.js"));
  Object.values(ZIP_TOWNS).flat().forEach((t) => assert(TOWNS.includes(t), t));
});

test("client marks the server-named field and shows the server message inline", () => {
  const js = read("frontend/js/order.js");
  assert(/markServerField\(result\);\n\s*showSubmitError\(orderErrorMessage\(result\)\)/.test(js));
  assert.strictEqual(C.orderErrorMessage({ ok: false, status: 400, error: "ZIP 77002 is outside our service area." }), "ZIP 77002 is outside our service area.");
});

(async () => {
  let failed = 0;
  for (const [n, f] of tests) { try { await f(); console.log("ok - " + n); } catch (e) { failed++; console.error("not ok - " + n + "\n  " + e.message); } }
  if (failed) { console.error(failed + " failed"); process.exit(1); }
  console.log("town-zip-validation tests passed");
})();
