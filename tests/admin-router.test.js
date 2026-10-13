#!/usr/bin/env node
/**
 * #33: admin router for beach permit flags + per-order weather hold.
 * No network: fake Supabase, real JWTs.
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const Module = require("module");
const jwt = require("jsonwebtoken");
const { createFakeSupabase } = require("./helpers/fake-supabase");

let currentFake = null;
const realLoad = Module._load;
Module._load = function (request) {
  if (request === "@supabase/supabase-js") return { createClient: () => currentFake };
  return realLoad.apply(this, arguments);
};

const SECRET = "test-admin-router-secret-32bytes!";
process.env.JWT_SECRET = SECRET;
process.env.SUPABASE_URL = "http://example.invalid";
process.env.SUPABASE_SERVICE_KEY = "test";
delete process.env.WEATHER_SHUTDOWN;
delete process.env.COYOTE_WEATHER_HOLD;

const ROOT = path.join(__dirname, "..");
const admin = require(path.join(ROOT, "netlify/functions/admin.js"));
const adminToken = jwt.sign({ role: "admin", user: "ops" }, SECRET);
const driverToken = jwt.sign({ role: "driver", driver_id: "d1" }, SECRET);

function ev(method, p, body, token) {
  return {
    httpMethod: method,
    path: "/.netlify/functions/admin" + p,
    headers: Object.assign({ origin: "https://coyote-dune-delivery.netlify.app" }, token ? { authorization: "Bearer " + token } : {}),
    body: body ? JSON.stringify(body) : null,
  };
}

function seed() {
  currentFake = createFakeSupabase({
    applications: [
      { id: "a-uuid-1", first_name: "Sam", last_name: "Reyes", email: "s@x.com", status: "pending", beach_permit_ok: false, beach_access_notes: null, notes: null, created_at: "2026-10-01" },
      { id: "a-uuid-2", first_name: "Jo", last_name: "Lee", email: "j@x.com", status: "pending", beach_permit_ok: true, beach_access_notes: "PA permit", notes: "ok", created_at: "2026-10-02" },
    ],
    orders: [
      { id: "o-1", order_number: "CDD-1", status: "pending", pickup_city: "Port Aransas", dropoff_city: "Mustang Island", weather_hold: false, created_at: "2026-10-12" },
    ],
    order_status_logs: [],
  });
}

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test("rejects missing token and non-admin token", async () => {
  seed();
  assert.strictEqual((await admin.handler(ev("GET", "/applications"))).statusCode, 401);
  assert.strictEqual((await admin.handler(ev("GET", "/applications", null, driverToken))).statusCode, 403);
  assert.strictEqual((await admin.handler(ev("PUT", "/orders/o-1/weather-hold", { weather_hold: true }, driverToken))).statusCode, 403);
  assert.strictEqual(currentFake.db.orders[0].weather_hold, false);
});

test("lists applications shaped for the dashboard", async () => {
  seed();
  const res = await admin.handler(ev("GET", "/applications", null, adminToken));
  assert.strictEqual(res.statusCode, 200, res.body);
  const apps = JSON.parse(res.body).applications;
  const jo = apps.find((a) => a.id === "a-uuid-2");
  assert.strictEqual(jo.name, "Jo Lee");
  assert.strictEqual(jo.beach_permit_ok, true);
  assert.strictEqual(jo.beach_access_notes, "PA permit");
  assert.strictEqual(jo.admin_notes, "ok");
});

test("admin edits beach permit flag + notes on an application", async () => {
  seed();
  const res = await admin.handler(ev("PUT", "/applications/a-uuid-1", { status: "approved", beach_permit_ok: true, beach_access_notes: "Nueces County permit", admin_notes: "called" }, adminToken));
  assert.strictEqual(res.statusCode, 200, res.body);
  const row = currentFake.db.applications.find((a) => a.id === "a-uuid-1");
  assert.strictEqual(row.beach_permit_ok, true);
  assert.strictEqual(row.beach_access_notes, "Nueces County permit");
  assert.strictEqual(row.notes, "called");
  assert.strictEqual(row.status, "approved");
});

test("application patch ignores non-whitelisted fields and bad values", async () => {
  seed();
  const bad = await admin.handler(ev("PUT", "/applications/a-uuid-1", { status: "hacked" }, adminToken));
  assert.strictEqual(bad.statusCode, 400);
  const badBool = await admin.handler(ev("PUT", "/applications/a-uuid-1", { beach_permit_ok: "maybe" }, adminToken));
  assert.strictEqual(badBool.statusCode, 400);
  const { patch } = admin._internal.buildApplicationPatch({ beach_permit_ok: false, email: "evil@x.com", ssn: "1", vehicle_class: "4x4" });
  assert.deepStrictEqual(Object.keys(patch).sort(), ["beach_permit_ok", "updated_at"]);
});

test("missing application is 404", async () => {
  seed();
  const res = await admin.handler(ev("PUT", "/applications/nope", { beach_permit_ok: true }, adminToken));
  assert.strictEqual(res.statusCode, 404);
});

test("bulk status uses string UUID ids", async () => {
  seed();
  const res = await admin.handler(ev("POST", "/applications/bulk", { ids: ["a-uuid-1", "a-uuid-2"], status: "on_hold" }, adminToken));
  assert.strictEqual(res.statusCode, 200, res.body);
  assert.ok(currentFake.db.applications.every((a) => a.status === "on_hold"));
});

test("delete is refused, nothing removed", async () => {
  seed();
  const res = await admin.handler(ev("DELETE", "/applications/a-uuid-1", null, adminToken));
  assert.strictEqual(res.statusCode, 405);
  assert.strictEqual(currentFake.db.applications.length, 2);
});

test("admin sets and clears per-order weather_hold, logged", async () => {
  seed();
  let res = await admin.handler(ev("PUT", "/orders/o-1/weather-hold", { weather_hold: true }, adminToken));
  assert.strictEqual(res.statusCode, 200, res.body);
  assert.strictEqual(currentFake.db.orders[0].weather_hold, true);
  res = await admin.handler(ev("PUT", "/orders/o-1/weather-hold", { weather_hold: false }, adminToken));
  assert.strictEqual(res.statusCode, 200, res.body);
  assert.strictEqual(currentFake.db.orders[0].weather_hold, false);
  assert.strictEqual(currentFake.db.order_status_logs.length, 2);
  assert.match(currentFake.db.order_status_logs[0].note, /Weather hold set/);
});

test("orders list + weather endpoint report WEATHER_SHUTDOWN read-only", async () => {
  seed();
  let res = await admin.handler(ev("GET", "/orders", null, adminToken));
  let body = JSON.parse(res.body);
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(body.orders.length, 1);
  assert.strictEqual(body.weather.active, false);
  process.env.WEATHER_SHUTDOWN = "1";
  process.env.WEATHER_SHUTDOWN_REASON = "Storm";
  try {
    res = await admin.handler(ev("GET", "/weather", null, adminToken));
    body = JSON.parse(res.body);
    assert.strictEqual(body.active, true);
    assert.strictEqual(body.reason, "Storm");
    const put = await admin.handler(ev("PUT", "/weather", { active: false }, adminToken));
    assert.strictEqual(put.statusCode, 404, "global gate stays env-only");
  } finally {
    delete process.env.WEATHER_SHUTDOWN;
    delete process.env.WEATHER_SHUTDOWN_REASON;
  }
});

test("routes /api/admin/* style paths too", () => {
  assert.deepStrictEqual(admin._internal.routeParts({ path: "/api/admin/orders/o-1/weather-hold" }), ["orders", "o-1", "weather-hold"]);
  assert.deepStrictEqual(admin._internal.routeParts({ path: "/.netlify/functions/admin/applications" }), ["applications"]);
});

test("dashboard wires beach fields + weather hold, no parseInt on UUID ids", () => {
  const js = fs.readFileSync(path.join(ROOT, "frontend/admin/admin.js"), "utf8");
  const html = fs.readFileSync(path.join(ROOT, "frontend/admin/index.html"), "utf8");
  assert.ok(js.includes("beach_permit_ok") && js.includes("beach_access_notes"));
  assert.ok(js.includes("/weather-hold"));
  assert.ok(!/parseInt\([^)]*dataset\.id/.test(js));
  assert.ok(html.includes('id="orders-table-body"') && html.includes('id="weather-banner"'));
});

(async () => {
  let failed = 0;
  for (const [name, fn] of tests) {
    try { await fn(); console.log("ok -", name); }
    catch (err) { failed += 1; console.error("not ok -", name); console.error(err && err.stack ? err.stack : err); }
  }
  if (failed) process.exit(1);
  console.log(tests.length + " passed");
})();
