#!/usr/bin/env node
// Customer-facing reads: without a valid token nothing comes back; with a
// customer token, location only while assigned / in progress, driver first
// name + vehicle only (no last name or phone), and no dispatcher log notes.
const assert = require("assert");
const path = require("path");
const Module = require("module");
const jwt = require("jsonwebtoken");
const { createFakeSupabase } = require("./helpers/fake-supabase");
process.env.JWT_SECRET = "test-secret-read-leaks-32-bytes!!!";
process.env.SUPABASE_URL = "http://fake"; process.env.SUPABASE_SERVICE_KEY = "fake";

let fake;
const realLoad = Module._load;
Module._load = function (r) { if (r === "@supabase/supabase-js") return { createClient: () => fake }; return realLoad.apply(this, arguments); };
const ROOT = path.join(__dirname, "..");
const loc = require(path.join(ROOT, "netlify/functions/get-driver-location.js")).handler;
const orders = require(path.join(ROOT, "netlify/functions/get-orders.js")).handler;
const S = process.env.JWT_SECRET;
const cust = jwt.sign({ role: "customer", order_id: "o1", order_number: "CDD-1" }, S);
const admin = jwt.sign({ role: "admin", user: "ops" }, S);
const H = (t) => (t ? { authorization: "Bearer " + t } : {});
const getLoc = (t, q = "order_id=o1") => loc({ httpMethod: "GET", headers: H(t), path: "/api/get-driver-location", rawQuery: q });
const getOrder = (t) => orders({ httpMethod: "GET", headers: H(t), path: "/api/get-orders", rawQuery: "" });

function seed(status) {
  fake = createFakeSupabase({
    orders: [{ id: "o1", order_number: "CDD-1", status, driver_id: "d1", assigned_at: "2026-10-22T15:00:00Z" }],
    driver_locations: [{ id: "L1", driver_id: "d1", order_id: "o1", lat: 27.8, lng: -97.1, timestamp: "2026-10-22T15:05:00Z" }],
    applications: [{ id: "d1", first_name: "Dana", last_name: "Driverson", phone: "+13615550100", email: "d@x.test", vehicle_make: "Jeep", vehicle_model: "Wrangler", vehicle_color: "Red" }],
  });
}
const tests = []; const test = (n, f) => tests.push([n, f]);

test("no token / bad token: 401, no location", async () => {
  seed("in_progress");
  for (const t of [null, "garbage", jwt.sign({ role: "customer", order_id: "o1" }, "wrong-secret")]) {
    const r = await getLoc(t);
    assert.strictEqual(r.statusCode, 401, String(t)); assert.ok(!/27\.8|Dana|3615550100/.test(r.body));
  }
});

test("customer: location only while assigned / in_progress", async () => {
  for (const s of ["assigned", "in_progress"]) { seed(s); assert.strictEqual((await getLoc(cust)).statusCode, 200, s); }
  for (const s of ["pending", "completed", "cancelled"]) {
    seed(s);
    const r = await getLoc(cust);
    assert.strictEqual(r.statusCode, 404, s); assert.ok(!/27\.8/.test(r.body), s);
  }
});

test("customer: driver first name + vehicle only, never last name or phone", async () => {
  seed("in_progress");
  const r = await getLoc(cust);
  const d = JSON.parse(r.body).data.driver;
  assert.strictEqual(d.first_name, "Dana"); assert.strictEqual(d.vehicle_make, "Jeep");
  assert.ok(!/Driverson|3615550100|d@x\.test/.test(r.body), r.body);
});

test("customer token can't widen to another order or a driver id", async () => {
  seed("in_progress");
  fake.db.orders.push({ id: "o2", status: "in_progress", driver_id: "d1", assigned_at: "2026-10-22T15:00:00Z" });
  const r = await getLoc(cust, "driver_id=d1&order_id=o2");
  assert.strictEqual(JSON.parse(r.body).data.location.order_id, "o1");
});

test("admin still sees a completed order's last point", async () => {
  seed("completed");
  assert.strictEqual((await getLoc(admin)).statusCode, 200);
});

test("get-orders: no token 401; customer view drops dispatcher log notes", async () => {
  seed("in_progress");
  assert.strictEqual((await getOrder(null)).statusCode, 401);
  const base = fake.from.bind(fake);
  const row = { id: "o1", order_number: "CDD-1", status: "in_progress", payment_status: "paid",
    customer: { first_name: "C", phone: "+13615550111" },
    status_logs: [{ status: "assigned", created_at: "t", note: "Admin ops: driver Dana Driverson; Warning: offline, call +13615550100", changed_by: "admin:ops" }] };
  fake.from = (t) => (t === "orders" ? { select: () => ({ eq: () => ({ single: async () => ({ data: row, error: null }) }) }) } : base(t));
  const r = await getOrder(cust);
  assert.strictEqual(r.statusCode, 200, r.body);
  const d = JSON.parse(r.body).data;
  assert.deepStrictEqual(d.status_logs, [{ status: "assigned", created_at: "t" }]);
  assert.ok(!/Driverson|3615550100|admin:ops/.test(r.body));
});

(async () => {
  let failed = 0;
  for (const [n, f] of tests) { try { await f(); console.log("ok -", n); } catch (e) { failed++; console.log("not ok -", n, "\n ", e.message); } }
  console.log(failed ? `${failed} failed` : `all ${tests.length} passed`); process.exit(failed ? 1 : 0);
})();
