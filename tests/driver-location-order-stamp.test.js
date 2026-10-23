#!/usr/bin/env node
// The driver app posts { lat, lng } with no order_id. /track/ (get-driver-location
// by order) only returns rows for that order, so update-driver-location must
// stamp the driver's active order or customers never see their driver.
const assert = require("assert");
const path = require("path");
const Module = require("module");
const jwt = require(require.resolve("jsonwebtoken", { paths: [path.join(__dirname, "..")] }));
const { createFakeSupabase } = require("./helpers/fake-supabase");
process.env.JWT_SECRET = "test-secret-location-stamp";
process.env.SUPABASE_URL = "http://fake"; process.env.SUPABASE_SERVICE_KEY = "fake";

let fake;
const origLoad = Module._load;
Module._load = function (req, ...rest) {
  return req === "@supabase/supabase-js" ? { createClient: () => fake } : origLoad.call(this, req, ...rest);
};
const fn = (n) => require(path.join(__dirname, "..", "netlify/functions", n));
const { handler: post } = fn("update-driver-location.js");
const { handler: getLoc } = fn("get-driver-location.js");

const drvTok = jwt.sign({ role: "driver", driver_id: "d1" }, process.env.JWT_SECRET);
const custTok = jwt.sign({ role: "customer", order_id: "o1" }, process.env.JWT_SECRET);
const postLoc = (body) => post({ httpMethod: "POST", headers: { authorization: "Bearer " + drvTok }, body: JSON.stringify(body) });
const track = () => getLoc({ httpMethod: "GET", headers: { authorization: "Bearer " + custTok }, path: "/api/get-driver-location", rawQuery: "order_id=o1", queryStringParameters: { order_id: "o1" } });
const seed = (orders) => { fake = createFakeSupabase({ orders, driver_locations: [], applications: [{ id: "d1", first_name: "Val", status: "approved" }] }); };

const tests = [];
const test = (n, f) => tests.push([n, f]);

test("driver app post (no order_id) is stamped with the assigned order; customer /track/ sees it", async () => {
  seed([{ id: "o1", driver_id: "d1", status: "assigned", assigned_at: "2020-01-01T00:00:00Z" }]);
  const r = await postLoc({ lat: 27.8, lng: -97.1, accuracy: 5 });
  assert.strictEqual(r.statusCode, 201, r.body);
  assert.strictEqual(JSON.parse(r.body).data.order_id, "o1");
  const t = await track();
  assert.strictEqual(t.statusCode, 200, t.body);
});

test("in_progress order is stamped too; completed/other drivers' orders are not", async () => {
  seed([
    { id: "oDone", driver_id: "d1", status: "completed", assigned_at: "2020-01-02T00:00:00Z" },
    { id: "oOther", driver_id: "d2", status: "assigned", assigned_at: "2020-01-03T00:00:00Z" },
    { id: "o1", driver_id: "d1", status: "in_progress", assigned_at: "2020-01-01T00:00:00Z" },
  ]);
  const r = await postLoc({ lat: 27.8, lng: -97.1 });
  assert.strictEqual(JSON.parse(r.body).data.order_id, "o1");
});

test("no active order -> order_id null; explicit order_id is kept", async () => {
  seed([{ id: "oDone", driver_id: "d1", status: "completed", assigned_at: "2020-01-01T00:00:00Z" }]);
  let r = await postLoc({ lat: 27.8, lng: -97.1 });
  assert.strictEqual(r.statusCode, 201, r.body);
  assert.strictEqual(JSON.parse(r.body).data.order_id, null);
  r = await postLoc({ lat: 27.8, lng: -97.1, order_id: "oX" });
  assert.strictEqual(JSON.parse(r.body).data.order_id, "oX");
});

test("order lookup failure does not block the location post", async () => {
  seed([]);
  const real = fake.from;
  fake.from = (t) => { if (t === "orders") throw new Error("db down"); return real(t); };
  const errs = []; const ce = console.error; console.error = (...a) => errs.push(a.join(" "));
  try {
    const r = await postLoc({ lat: 27.8, lng: -97.1 });
    assert.strictEqual(r.statusCode, 201, r.body);
    assert.strictEqual(JSON.parse(r.body).data.order_id, null);
    assert(errs.some((e) => /active order lookup/.test(e)));
  } finally { console.error = ce; }
});

(async () => {
  let failed = 0;
  for (const [n, f] of tests) {
    try { await f(); console.log("ok - " + n); } catch (e) { failed++; console.log("not ok - " + n + "\n  " + (e && e.stack || e)); }
  }
  if (failed) process.exit(1);
})();
