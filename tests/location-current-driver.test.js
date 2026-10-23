#!/usr/bin/env node
// get-driver-location by order: after a reassignment the customer must not see
// the previous driver's last GPS point. Only rows from orders.driver_id,
// recorded at/after orders.assigned_at, are returned. Supabase is faked.
const assert = require("assert");
const path = require("path");
const Module = require("module");
const jwt = require(require.resolve("jsonwebtoken", { paths: [path.join(__dirname, "..")] }));
process.env.JWT_SECRET = "test-secret-location-current-driver";
process.env.SUPABASE_URL = "http://fake"; process.env.SUPABASE_SERVICE_KEY = "fake";

let db;
function table(name) {
  let rows = (db[name] || []).slice();
  const q = {
    select() { return q; },
    eq(c, v) { rows = rows.filter((r) => r[c] === v); return q; },
    gte(c, v) { rows = rows.filter((r) => r[c] >= v); return q; },
    order(c, o) { rows.sort((a, b) => (a[c] < b[c] ? 1 : -1) * (o && o.ascending ? -1 : 1)); return q; },
    limit(n) { rows = rows.slice(0, n); return q; },
    maybeSingle() { return Promise.resolve({ data: rows[0] || null, error: null }); },
    then(res, rej) { return Promise.resolve({ data: rows, error: null }).then(res, rej); },
  };
  return q;
}
const fake = { createClient: () => ({ from: table }) };
const origLoad = Module._load;
Module._load = function (req, ...rest) { return req === "@supabase/supabase-js" ? fake : origLoad.call(this, req, ...rest); };
const { handler } = require(path.join(__dirname, "..", "netlify/functions/get-driver-location.js"));

const custToken = jwt.sign({ role: "customer", order_id: "o1" }, process.env.JWT_SECRET);
const call = () => handler({ httpMethod: "GET", headers: { authorization: "Bearer " + custToken }, path: "/api/get-driver-location", rawQuery: "order_id=o1" });
const loc = (id, driver, ts) => ({ id, driver_id: driver, order_id: "o1", lat: 27.8, lng: -97.1, timestamp: ts });

const tests = [];
const test = (n, f) => tests.push([n, f]);
test("reassigned order: old driver's newer point is hidden until the new driver reports (404)", async () => {
  db = { orders: [{ id: "o1", status: "assigned", driver_id: "dB", assigned_at: "2026-10-22T15:00:00Z" }],
    driver_locations: [loc("L1", "dA", "2026-10-22T15:01:00Z")], applications: [] };
  const r = await call();
  assert.strictEqual(r.statusCode, 404, r.body);
});
test("new driver's point after assignment is returned, not the old driver's", async () => {
  db = { orders: [{ id: "o1", status: "assigned", driver_id: "dB", assigned_at: "2026-10-22T15:00:00Z" }],
    driver_locations: [loc("L1", "dA", "2026-10-22T15:05:00Z"), loc("L2", "dB", "2026-10-22T15:02:00Z")], applications: [] };
  const r = await call();
  assert.strictEqual(r.statusCode, 200, r.body);
  assert.strictEqual(JSON.parse(r.body).data.location.id, "L2");
});
test("current driver's point from before the assignment is not shown", async () => {
  db = { orders: [{ id: "o1", status: "assigned", driver_id: "dB", assigned_at: "2026-10-22T15:00:00Z" }],
    driver_locations: [loc("L0", "dB", "2026-10-22T14:00:00Z")], applications: [] };
  assert.strictEqual((await call()).statusCode, 404);
});
test("unassigned order -> 404 even with stale rows", async () => {
  db = { orders: [{ id: "o1", driver_id: null, assigned_at: null }], driver_locations: [loc("L1", "dA", "2026-10-22T15:01:00Z")], applications: [] };
  assert.strictEqual((await call()).statusCode, 404);
});

(async () => {
  let failed = 0;
  for (const [n, f] of tests) { try { await f(); console.log("  ok  " + n); } catch (e) { failed++; console.log("  FAIL " + n + "\n    " + e.message); } }
  console.log(`${tests.length - failed}/${tests.length} location-current-driver tests passed`);
  if (failed) process.exit(1);
})();
