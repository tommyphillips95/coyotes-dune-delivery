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
  await post(Object.assign(base(), { schedule: "later", scheduled_date: "2026-10-19", scheduled_time: "09:30" }));
  let row = currentFake.db.orders[0];
  assert.strictEqual(row.is_asap, false);
  assert.strictEqual(row.scheduled_date, "2026-10-19");
  assert.strictEqual(row.scheduled_time, "09:30");

  currentFake = freshDb();
  await post(Object.assign(base(), { schedule: "later", scheduled_date: "2026-10-19" })); // no time
  row = currentFake.db.orders[0];
  assert.strictEqual(row.is_asap, true);
  assert.strictEqual(row.scheduled_date, null);
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
