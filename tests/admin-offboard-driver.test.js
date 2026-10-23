#!/usr/bin/env node
/**
 * Moving a driver off "approved" (row action, detail modal, or bulk) takes
 * them offline, expires their open dispatch offers, and returns the orders
 * still assigned to them with a warning so dispatch can reassign. Orders are
 * not modified. Approving does none of this. Fake Supabase, real JWTs.
 */
const assert = require("assert");
const path = require("path");
const Module = require("module");
const jwt = require("jsonwebtoken");
const { createFakeSupabase } = require("./helpers/fake-supabase");

let fake = null;
const realLoad = Module._load;
Module._load = function (request) {
  if (request === "@supabase/supabase-js") return { createClient: () => fake };
  return realLoad.apply(this, arguments);
};
process.env.JWT_SECRET = "test-admin-offboard-secret-32bytes!";
process.env.SUPABASE_URL = "http://example.invalid";
process.env.SUPABASE_SERVICE_KEY = "test";
const admin = require(path.join(__dirname, "..", "netlify/functions/admin.js"));
const T = jwt.sign({ role: "admin", user: "ops" }, process.env.JWT_SECRET);
const call = (method, p, body) => admin.handler({ httpMethod: method, path: "/.netlify/functions/admin" + p, headers: { authorization: "Bearer " + T }, body: JSON.stringify(body) });

function seed() {
  fake = createFakeSupabase({
    applications: [
      { id: "d1", first_name: "Val", status: "approved", online: true, created_at: "2026-10-01" },
      { id: "d2", first_name: "Kim", status: "approved", online: true, created_at: "2026-10-02" },
    ],
    dispatch_offers: [
      { id: "of1", order_id: "o3", driver_id: "d1", status: "offered" },
      { id: "of2", order_id: "o4", driver_id: "d1", status: "accepted" },
      { id: "of3", order_id: "o3", driver_id: "d2", status: "offered" },
    ],
    orders: [
      { id: "o1", order_number: "CDD-1", status: "assigned", driver_id: "d1" },
      { id: "o2", order_number: "CDD-2", status: "in_progress", driver_id: "d1" },
      { id: "o4", order_number: "CDD-4", status: "completed", driver_id: "d1" },
      { id: "o5", order_number: "CDD-5", status: "assigned", driver_id: "d2" },
    ],
    order_status_logs: [],
  });
}
const db = () => fake.db;
const tests = [];
const test = (n, f) => tests.push([n, f]);

for (const status of ["rejected", "on_hold", "pending"]) {
  test(`PUT /applications/d1 status=${status}: offline, open offer expired, active orders listed`, async () => {
    seed();
    const ordersBefore = JSON.stringify(db().orders);
    const r = await call("PUT", "/applications/d1", { status });
    assert.strictEqual(r.statusCode, 200, r.body);
    const b = JSON.parse(r.body);
    assert.strictEqual(db().applications[0].online, false);
    assert.strictEqual(db().applications[1].online, true, "other driver untouched");
    assert.deepStrictEqual(db().dispatch_offers.map((o) => o.status), ["expired", "accepted", "offered"]);
    assert.deepStrictEqual(b.active_orders.map((o) => o.order_number).sort(), ["CDD-1", "CDD-2"]);
    assert.match(b.warning, /CDD-1/); assert.match(b.warning, /Reassign/);
    assert.strictEqual(b.data.online, false);
    assert.strictEqual(JSON.stringify(db().orders), ordersBefore, "orders not modified");
  });
}

test("bulk de-approve: both drivers offboarded, all their active orders listed", async () => {
  seed();
  const r = await call("POST", "/applications/bulk", { ids: ["d1", "d2"], status: "rejected" });
  assert.strictEqual(r.statusCode, 200, r.body);
  const b = JSON.parse(r.body);
  assert.ok(db().applications.every((a) => a.online === false));
  assert.ok(db().dispatch_offers.filter((o) => o.id !== "of2").every((o) => o.status === "expired"));
  assert.deepStrictEqual(b.active_orders.map((o) => o.order_number).sort(), ["CDD-1", "CDD-2", "CDD-5"]);
});

test("no active orders: no warning", async () => {
  seed();
  db().orders = db().orders.filter((o) => o.driver_id !== "d2");
  const r = await call("PUT", "/applications/d2", { status: "rejected" });
  const b = JSON.parse(r.body);
  assert.deepStrictEqual(b.active_orders, []);
  assert.strictEqual(b.warning, null);
  assert.strictEqual(db().dispatch_offers[2].status, "expired");
});

test("approving or editing notes doesn't offboard", async () => {
  seed();
  await call("PUT", "/applications/d1", { status: "approved" });
  await call("PUT", "/applications/d1", { admin_notes: "hi" });
  await call("POST", "/applications/bulk", { ids: ["d1"], status: "approved" });
  assert.strictEqual(db().applications[0].online, true);
  assert.strictEqual(db().dispatch_offers[0].status, "offered");
});

(async () => {
  let failed = 0;
  console.log("admin-offboard-driver.test.js");
  for (const [n, f] of tests) {
    try { await f(); console.log("  ok - " + n); }
    catch (e) { failed++; console.error("  FAIL - " + n + "\n    " + String(e.message || e).split("\n")[0]); }
  }
  Module._load = realLoad;
  if (failed) { console.error(`admin-offboard-driver: ${failed} failed`); process.exit(1); }
  console.log(`admin-offboard-driver: ${tests.length} passed`);
})();
