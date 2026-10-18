#!/usr/bin/env node
/**
 * POST /api/create-order contract (the one order path; /api/submit-order is an alias).
 * No network: @supabase/supabase-js is swapped for tests/helpers/fake-supabase,
 * Twilio env is unset so no SMS is attempted.
 */
const assert = require("assert");
const path = require("path");
const Module = require("module");
const jwt = require("jsonwebtoken");
const { createFakeSupabase } = require("./helpers/fake-supabase");

for (const k of ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_PHONE_NUMBER", "WEATHER_SHUTDOWN", "COYOTE_WEATHER_HOLD", "WEATHER_SHUTDOWN_REASON"]) {
  delete process.env[k];
}
process.env.SUPABASE_URL = "http://example.invalid";
process.env.SUPABASE_SERVICE_KEY = "test";
process.env.SITE_ORIGIN = "https://coyote-dune-delivery.netlify.app";
const SECRET = "test-secret-at-least-16";
process.env.JWT_SECRET = SECRET;

let currentFake = null;
const realLoad = Module._load;
Module._load = function (request) {
  if (request === "@supabase/supabase-js") return { createClient: () => currentFake };
  return realLoad.apply(this, arguments);
};

const FN = path.join(__dirname, "..", "netlify/functions");
const createOrder = require(path.join(FN, "create-order.js"));
const { priceQuote } = require(path.join(FN, "zones.js"));
const V = createOrder._validation;
// Chicago wall-clock date/time for an instant (dates in tests are relative to now).
const chicago = (ms) => V.chicagoWallClock(new Date(ms)).split("T");
const [FUTURE_DATE] = chicago(Date.now() + 36 * 3600 * 1000);

const freshDb = () => createFakeSupabase({ customers: [], orders: [], order_status_logs: [], sms_logs: [] });
const base = () => ({
  first_name: "Test", last_name: "Customer", phone: "3615550100",
  pickup_address: "1 Beach Access Rd", pickup_city: "Port Aransas", pickup_zip: "78373",
  dropoff_address: "Pin 12", dropoff_city: "Mustang Island", dropoff_zip: "78373",
  service_type: "ride", passenger_count: 1,
});
const post = (body, method) => createOrder.handler({
  httpMethod: method || "POST",
  headers: { origin: process.env.SITE_ORIGIN },
  body: body === undefined ? undefined : JSON.stringify(body),
});

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test("OPTIONS is 204, GET is 405", async () => {
  currentFake = freshDb();
  assert.strictEqual((await post(undefined, "OPTIONS")).statusCode, 204);
  assert.strictEqual((await post(undefined, "GET")).statusCode, 405);
});

test("400 on missing required fields, nothing written", async () => {
  for (const drop of [["first_name"], ["phone"], ["pickup_address"], ["pickup_city"], ["service_type"]]) {
    currentFake = freshDb();
    const body = base();
    drop.forEach((k) => delete body[k]);
    const res = await post(body);
    assert.strictEqual(res.statusCode, 400, drop.join() + " -> " + res.body);
    assert.ok(JSON.parse(res.body).error);
    assert.strictEqual(currentFake.db.orders.length, 0);
    assert.strictEqual(currentFake.db.customers.length, 0);
  }
});

test("stored estimated_price is the server quote (Port A -> Mustang ride = $35, 4x4)", async () => {
  currentFake = freshDb();
  const res = await post(Object.assign(base(), { estimated_price: 1, total: 1 })); // client price ignored
  assert.strictEqual(res.statusCode, 201, res.body);
  const body = JSON.parse(res.body);
  const row = currentFake.db.orders[0];
  const q = priceQuote("Port Aransas", "Mustang Island", { service_type: "ride", passenger_count: 1 });
  assert.strictEqual(row.estimated_price, q.total);
  assert.strictEqual(row.estimated_price, 35);
  assert.strictEqual(body.estimatedPrice, 35);
  assert.strictEqual(body.miles, q.miles);
  assert.strictEqual(row.required_vehicle_class, "4x4");
  assert.strictEqual(row.status, "pending");
  assert.match(body.orderNumber, /^CDD-[0-9A-Z]+-[0-9A-Z]{1,3}$/);
  assert.strictEqual(currentFake.db.order_status_logs.length, 1);
});

test("missing dropoff city is priced in-town at the pickup city", async () => {
  currentFake = freshDb();
  const b = Object.assign(base(), { pickup_city: "Corpus Christi" });
  delete b.dropoff_city; delete b.dropoff_address; delete b.dropoff_zip;
  const res = await post(b);
  assert.strictEqual(res.statusCode, 201, res.body);
  const row = currentFake.db.orders[0];
  assert.strictEqual(row.estimated_price, priceQuote("Corpus Christi", "Corpus Christi", { service_type: "ride", passenger_count: 1 }).total);
  assert.strictEqual(row.dropoff_city, null);
});

test("schedule=later with date+time is stored; otherwise ASAP", async () => {
  currentFake = freshDb();
  await post(Object.assign(base(), { schedule: "later", scheduled_date: FUTURE_DATE, scheduled_time: "09:30" }));
  let row = currentFake.db.orders[0];
  assert.strictEqual(row.is_asap, false);
  assert.strictEqual(row.scheduled_date, FUTURE_DATE);
  assert.strictEqual(row.scheduled_time, "09:30");

  currentFake = freshDb();
  await post(Object.assign(base(), { schedule: "later", scheduled_date: FUTURE_DATE })); // no time
  row = currentFake.db.orders[0];
  assert.strictEqual(row.is_asap, true);
  assert.strictEqual(row.scheduled_date, null);
});

test("chicagoWallClock uses America/Chicago (CDT and CST)", () => {
  assert.strictEqual(V.chicagoWallClock(new Date("2026-10-19T01:00:00Z")), "2026-10-18T20:00"); // CDT, UTC already tomorrow
  assert.strictEqual(V.chicagoWallClock(new Date("2026-12-01T05:30:00Z")), "2026-11-30T23:30"); // CST
});

test("scheduleError: past, bad format, impossible dates, future ok", () => {
  const now = new Date("2026-10-19T01:00:00Z"); // Sun Oct 18 8:00 PM CDT
  assert.match(V.scheduleError("2026-10-18", "19:59", now), /already passed/);
  assert.match(V.scheduleError("2026-10-17", "23:00", now), /already passed/);
  assert.strictEqual(V.scheduleError("2026-10-18", "20:00", now), null);
  assert.strictEqual(V.scheduleError("2026-10-18", "21:15", now), null); // later tonight (UTC date is the 19th)
  assert.strictEqual(V.scheduleError("2026-10-19", "08:00:00", now), null);
  for (const [d, t] of [["10/19/2026", "09:00"], ["2026-10-19", "9am"], ["2026-02-30", "09:00"], ["2026-10-19", "24:00"]]) {
    assert.match(V.scheduleError(d, t, now), /valid date and time/, d + " " + t);
  }
});

test("400 when a scheduled pickup is in the past (Chicago time); nothing written", async () => {
  const [d, t] = chicago(Date.now() - 2 * 3600 * 1000);
  currentFake = freshDb();
  const res = await post(Object.assign(base(), { schedule: "later", scheduled_date: d, scheduled_time: t }));
  assert.strictEqual(res.statusCode, 400, res.body);
  assert.match(JSON.parse(res.body).error, /already passed/);
  assert.strictEqual(currentFake.db.orders.length, 0);
  assert.strictEqual(currentFake.db.customers.length, 0);
});

test("400 on a malformed ZIP; ZIP+4 and missing optional ZIPs are fine", async () => {
  for (const [field, zip] of [["pickup_zip", "7837"], ["dropoff_zip", "abcde"], ["pickup_zip", "78373 "+"x"]]) {
    currentFake = freshDb();
    const res = await post(Object.assign(base(), { [field]: zip }));
    assert.strictEqual(res.statusCode, 400, field + "=" + zip);
    assert.match(JSON.parse(res.body).error, /5-digit ZIP/);
    assert.strictEqual(currentFake.db.orders.length, 0);
  }
  currentFake = freshDb();
  assert.strictEqual((await post(Object.assign(base(), { pickup_zip: "78373-1234", dropoff_zip: null }))).statusCode, 201);
  currentFake = freshDb();
  const noZip = base(); delete noZip.pickup_zip; delete noZip.dropoff_zip;
  assert.strictEqual((await post(noZip)).statusCode, 201);
});

test("repeat phone reuses the customer row", async () => {
  currentFake = freshDb();
  await post(base());
  await post(Object.assign(base(), { phone: " 3615550100 " }));
  assert.strictEqual(currentFake.db.customers.length, 1);
  assert.strictEqual(currentFake.db.orders.length, 2);
  assert.strictEqual(currentFake.db.orders[0].customer_id, currentFake.db.orders[1].customer_id);
});

test("returns an order-scoped customer tracking token", async () => {
  currentFake = freshDb();
  const body = JSON.parse((await post(base())).body);
  const claims = jwt.verify(body.trackingToken, SECRET);
  assert.strictEqual(claims.role, "customer");
  assert.strictEqual(claims.order_id, body.orderId);
  assert.strictEqual(claims.order_number, body.orderNumber);
});

test("no SMS attempted or logged when Twilio env is unset", async () => {
  currentFake = freshDb();
  assert.strictEqual((await post(base())).statusCode, 201);
  assert.strictEqual(currentFake.db.sms_logs.length, 0);
});

test("500 does not leak internal database error text", async () => {
  const fake = freshDb();
  const realFrom = fake.from;
  fake.from = (name) => {
    if (name !== "orders") return realFrom(name);
    const b = realFrom(name);
    b.then = (resolve) => resolve({ data: null, error: new Error('duplicate key value violates unique constraint "orders_order_number_key"') });
    return b;
  };
  currentFake = fake;
  const origError = console.error;
  console.error = () => {}; // keep CI log clean; the handler still logs server-side
  let res;
  try { res = await post(base()); } finally { console.error = origError; }
  assert.strictEqual(res.statusCode, 500);
  assert.ok(!/duplicate key|constraint|orders_/.test(res.body), res.body);
  assert.strictEqual(JSON.parse(res.body).error, "Failed to create order");
});

// ── Idempotency: one order per checkout attempt ──
const KEY = "3b0c4f9e-8a51-4d7e-9a3c-1f2e3d4c5b6a";

/** Wrap a fake so orders queries/inserts can be made to fail like real PostgREST. */
function withOrdersHook(fake, hook) {
  const realFrom = fake.from;
  fake.from = (name) => {
    const b = realFrom(name);
    if (name !== "orders") return b;
    const st = { eqs: {}, insert: null };
    const eq = b.eq, insert = b.insert, then = b.then;
    b.eq = (c, v) => { st.eqs[c] = v; return eq(c, v); };
    b.insert = (rows) => { st.insert = rows; return insert(rows); };
    b.then = (res, rej) => {
      const r = hook(st);
      return r ? res(r) : then(res, rej);
    };
    return b;
  };
  return fake;
}

test("same idempotency_key twice -> one order, original returned", async () => {
  currentFake = freshDb();
  const first = await post(Object.assign(base(), { idempotency_key: KEY }));
  assert.strictEqual(first.statusCode, 201, first.body);
  const second = await post(Object.assign(base(), { idempotency_key: KEY }));
  assert.strictEqual(second.statusCode, 200, second.body);
  const a = JSON.parse(first.body), b = JSON.parse(second.body);
  assert.strictEqual(b.replayed, true);
  for (const k of ["orderId", "orderNumber", "estimatedPrice", "miles", "requiredClass", "status"]) assert.deepStrictEqual(b[k], a[k], k);
  assert.strictEqual(jwt.verify(b.trackingToken, SECRET).order_id, a.orderId);
  assert.strictEqual(currentFake.db.orders.length, 1);
  assert.strictEqual(currentFake.db.customers.length, 1);
  assert.strictEqual(currentFake.db.order_status_logs.length, 1, "no second status log");
  assert.strictEqual(currentFake.db.orders[0].idempotency_key, KEY);
});

test("different keys (or no key) create separate orders", async () => {
  currentFake = freshDb();
  await post(Object.assign(base(), { idempotency_key: KEY }));
  await post(Object.assign(base(), { idempotency_key: KEY.replace(/a$/, "b") }));
  await post(base());
  assert.strictEqual(currentFake.db.orders.length, 3);
  assert.strictEqual(currentFake.db.orders[2].idempotency_key, undefined, "no key -> column not set");
});

test("repeated key from a different phone is 409, nothing created", async () => {
  currentFake = freshDb();
  await post(Object.assign(base(), { idempotency_key: KEY }));
  const res = await post(Object.assign(base(), { idempotency_key: KEY, phone: "3615559999" }));
  assert.strictEqual(res.statusCode, 409, res.body);
  assert.ok(!/order_number|orderId|trackingToken/.test(res.body));
  assert.strictEqual(currentFake.db.orders.length, 1);
});

test("malformed idempotency_key is 400", async () => {
  for (const k of ["short", "has spaces in it 1234", "x".repeat(101), "<script>alert(1)</script>"]) {
    currentFake = freshDb();
    const res = await post(Object.assign(base(), { idempotency_key: k }));
    assert.strictEqual(res.statusCode, 400, k);
    assert.strictEqual(currentFake.db.orders.length, 0);
  }
});

test("a retry during a weather hold still returns the order already placed", async () => {
  currentFake = freshDb();
  await post(Object.assign(base(), { idempotency_key: KEY }));
  process.env.WEATHER_SHUTDOWN = "1";
  try {
    const res = await post(Object.assign(base(), { idempotency_key: KEY }));
    assert.strictEqual(res.statusCode, 200, res.body);
    // ...but a new checkout is still refused
    assert.strictEqual((await post(Object.assign(base(), { idempotency_key: KEY + "x" }))).statusCode, 503);
  } finally {
    delete process.env.WEATHER_SHUTDOWN;
  }
});

test("before the migration (no idempotency_key column) orders still go through", async () => {
  const missing = { data: null, error: { code: "42703", message: 'column orders.idempotency_key does not exist' } };
  currentFake = withOrdersHook(freshDb(), (st) => {
    if ("idempotency_key" in st.eqs) return missing;
    if (st.insert && st.insert[0] && "idempotency_key" in st.insert[0]) return missing;
    return null;
  });
  const origWarn = console.warn; console.warn = () => {};
  let res;
  try { res = await post(Object.assign(base(), { idempotency_key: KEY })); } finally { console.warn = origWarn; }
  assert.strictEqual(res.statusCode, 201, res.body);
  assert.strictEqual(currentFake.db.orders.length, 1);
  assert.strictEqual(currentFake.db.orders[0].idempotency_key, undefined);
});

test("concurrent duplicate (unique violation on insert) returns the winning order", async () => {
  const fake = freshDb();
  // The other request already inserted this key; our first lookup missed it.
  fake.db.customers.push({ id: "c-win", phone: "3615550100", first_name: "Test", last_name: "Customer" });
  const winner = { id: "o-win", order_number: "CDD-WIN-1", customer_id: "c-win", idempotency_key: KEY, service_type: "ride",
    pickup_city: "Port Aransas", dropoff_city: "Mustang Island", passenger_count: 1, estimated_price: 35, required_vehicle_class: "4x4", status: "pending" };
  let lookups = 0;
  currentFake = withOrdersHook(fake, (st) => {
    if ("idempotency_key" in st.eqs) { lookups++; return { data: lookups === 1 ? null : Object.assign({}, winner), error: null }; }
    if (st.insert) return { data: null, error: { code: "23505", message: 'duplicate key value violates unique constraint "orders_idempotency_key_uidx"' } };
    return null;
  });
  const res = await post(Object.assign(base(), { idempotency_key: KEY }));
  assert.strictEqual(res.statusCode, 200, res.body);
  const body = JSON.parse(res.body);
  assert.strictEqual(body.orderId, "o-win");
  assert.strictEqual(body.replayed, true);
});

test("order form sends one key per attempt and reuses it on retry", () => {
  const fs = require("fs");
  const src = fs.readFileSync(path.join(__dirname, "..", "frontend/js/order.js"), "utf8");
  assert.ok(/idempotency_key: checkoutIdempotencyKey\(\)/.test(src), "orderData carries the key");
  assert.ok(/if \(!checkoutKey\) checkoutKey = newIdempotencyKey\(\)/.test(src), "key is created once and reused");
  assert.ok(/if \(result\.ok\) \{\s*checkoutKey = null;/.test(src), "success clears it");
  assert.ok(/form\.addEventListener\('input', resetCheckoutKey\)/.test(src), "edits start a new attempt");
  assert.ok(/randomUUID/.test(src));
  // The failure branches must not clear the key (that is what makes retry safe).
  const fail = src.slice(src.indexOf("} else {", src.indexOf("if (result.ok) {")), src.indexOf("const trackBtn"));
  assert.ok(!/checkoutKey = null/.test(fail), "failure keeps the key for the retry");
  const sql = fs.readFileSync(path.join(__dirname, "..", "schema/order_idempotency.sql"), "utf8");
  assert.ok(/ADD COLUMN IF NOT EXISTS idempotency_key TEXT/.test(sql));
  assert.ok(/CREATE UNIQUE INDEX IF NOT EXISTS orders_idempotency_key_uidx[\s\S]*WHERE idempotency_key IS NOT NULL/.test(sql));
});

(async () => {
  let failed = 0;
  for (const [name, fn] of tests) {
    try {
      await fn();
      console.log("ok -", name);
    } catch (err) {
      failed += 1;
      console.error("not ok -", name);
      console.error(err && err.stack ? err.stack : err);
    }
  }
  if (failed) process.exit(1);
  console.log("create-order: " + tests.length + " passed");
})();
