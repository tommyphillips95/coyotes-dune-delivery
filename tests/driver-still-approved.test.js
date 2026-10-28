#!/usr/bin/env node
/**
 * A driver JWT lives 7 days, but approval can be revoked sooner. Every
 * authenticated driver request re-checks applications.status: location posts,
 * pending offers, accepting offers and location reads. A removed (suspended,
 * rejected, deleted) driver is rejected at once (403) and nothing is written.
 * Approved drivers and admins are unaffected. Stubbed Supabase, no network.
 */
const assert = require("assert");
const path = require("path");
const Module = require("module");
const jwt = require("jsonwebtoken");
const { createFakeSupabase } = require("./helpers/fake-supabase");

process.env.JWT_SECRET = process.env.JWT_SECRET || "driver-still-approved-secret-32chars";
delete process.env.TWILIO_ACCOUNT_SID;
let fake = null;
const realLoad = Module._load;
Module._load = function (request) {
  if (request === "@supabase/supabase-js") return { createClient: () => fake };
  return realLoad.apply(this, arguments);
};
const FN = path.join(__dirname, "..", "netlify/functions");
const h = (n) => require(path.join(FN, n + ".js")).handler;
const tok = (claims) => ({ authorization: "Bearer " + jwt.sign(claims, process.env.JWT_SECRET, { expiresIn: "1h" }) });
const DRV = tok({ role: "driver", driver_id: "d1" });

function seed(app) {
  fake = createFakeSupabase({
    applications: app === null ? [] : [Object.assign({ id: "d1", first_name: "D", last_name: "One", status: "approved", online: true, vehicle_class: "4x4", vehicle_class_verified_at: "2026-10-01T00:00:00Z" }, app)],
    orders: [{ id: "o1", order_number: "CDD-1", status: "pending", payment_status: "paid", driver_id: null, customer_id: "c1", pickup_city: "Port Aransas", dropoff_city: "Mustang Island", pickup_lat: 27.83, pickup_lng: -97.06 }],
    customers: [{ id: "c1", phone: null }],
    dispatch_offers: [{ id: "of1", order_id: "o1", driver_id: "d1", status: "offered", expires_at: new Date(Date.now() + 60000).toISOString() }],
    driver_locations: [{ id: "l1", driver_id: "d1", lat: 27.8, lng: -97.0, timestamp: "2026-10-23T15:00:00Z" }],
    order_status_logs: [],
  });
}
const calls = {
  "update-driver-location": () => h("update-driver-location")({ httpMethod: "POST", headers: DRV, body: JSON.stringify({ lat: 27.81, lng: -97.05 }) }),
  "pending-offer": () => h("pending-offer")({ httpMethod: "GET", headers: DRV, queryStringParameters: {} }),
  "respond-offer accept": () => h("respond-offer")({ httpMethod: "POST", headers: DRV, body: JSON.stringify({ offer_id: "of1", action: "accept" }) }),
  "get-driver-location": () => h("get-driver-location")({ httpMethod: "GET", headers: DRV, queryStringParameters: {} }),
};
const tests = [];
const test = (n, f) => tests.push([n, f]);

for (const [name, call] of Object.entries(calls)) {
  for (const [label, app] of [["suspended", { status: "suspended" }], ["rejected", { status: "rejected" }], ["deleted", null]]) {
    test(`${name}: ${label} driver with a still-valid token → 403, nothing written`, async () => {
      seed(app);
      const before = JSON.stringify({ o: fake.db.orders, of: fake.db.dispatch_offers, l: fake.db.driver_locations, a: fake.db.applications });
      const r = await call();
      assert.strictEqual(r.statusCode, 403, r.body);
      assert.strictEqual(JSON.stringify({ o: fake.db.orders, of: fake.db.dispatch_offers, l: fake.db.driver_locations, a: fake.db.applications }), before);
    });
  }
  test(`${name}: approved driver still works`, async () => {
    seed({});
    const r = await call();
    assert.ok(r.statusCode === 200 || r.statusCode === 201, r.body);
  });
}

test("respond-offer: admin acting for a driver is not blocked by the driver check", async () => {
  seed({});
  const r = await h("respond-offer")({ httpMethod: "POST", headers: tok({ role: "admin" }), body: JSON.stringify({ offer_id: "of1", driver_id: "d1", action: "decline" }) });
  assert.strictEqual(r.statusCode, 200, r.body);
});

(async () => {
  let failed = 0;
  console.log("driver-still-approved.test.js");
  for (const [n, f] of tests) {
    try { await f(); console.log("  ok - " + n); }
    catch (e) { failed++; console.error("  FAIL - " + n + "\n    " + (e.message || e).split("\n")[0]); }
  }
  Module._load = realLoad;
  if (failed) { console.error(`driver-still-approved: ${failed} failed`); process.exit(1); }
  console.log(`driver-still-approved: ${tests.length} passed`);
})();
