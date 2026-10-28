#!/usr/bin/env node
/**
 * create-order gaps not covered by create-order.test.js: last_name required,
 * client-set money/status fields ignored, numeric parsing, bad JSON, and the order page card/pay-driver handoff.
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

const fs = require("fs");

test("missing last_name is 400, nothing written", async () => {
  currentFake = freshDb();
  const body = base(); delete body.last_name;
  const res = await post(body);
  assert.strictEqual(res.statusCode, 400, res.body);
  assert.strictEqual(currentFake.db.orders.length, 0);
  assert.strictEqual(currentFake.db.customers.length, 0);
});

test("client can't set payment, status, price, vehicle or weather fields", async () => {
  currentFake = freshDb();
  const res = await post(Object.assign(base(), {
    payment_status: "paid", status: "delivered", final_price: 0.01, estimated_price: 0.01,
    stripe_payment_intent_id: "pi_fake", required_vehicle_class: "sedan", weather_hold: true,
    order_number: "CDD-HACK", customer_id: "someone-else", id: "x",
  }));
  assert.strictEqual(res.statusCode, 201, res.body);
  const row = currentFake.db.orders[0];
  assert.notStrictEqual(row.payment_status, "paid");
  assert.strictEqual(row.stripe_payment_intent_id, undefined);
  assert.strictEqual(row.status, "pending");
  assert.strictEqual(row.final_price, null);
  assert.strictEqual(row.estimated_price, 35);
  assert.strictEqual(row.required_vehicle_class, "4x4");
  assert.strictEqual(row.weather_hold, false);
  assert.notStrictEqual(row.order_number, "CDD-HACK");
  assert.strictEqual(row.customer_id, currentFake.db.customers[0].id);
});

test("numeric fields: string passenger_count and tip are parsed; absent ones default", async () => {
  currentFake = freshDb();
  let res = await post(Object.assign(base(), { passenger_count: "3", tip_amount: "2.50" }));
  assert.strictEqual(res.statusCode, 201, res.body);
  assert.strictEqual(currentFake.db.orders[0].passenger_count, 3);
  assert.strictEqual(currentFake.db.orders[0].tip_amount, 2.5);
  currentFake = freshDb();
  const b = base(); delete b.passenger_count;
  res = await post(b);
  assert.strictEqual(res.statusCode, 201, res.body);
  assert.strictEqual(currentFake.db.orders[0].passenger_count, 1);
  assert.strictEqual(currentFake.db.orders[0].tip_amount, 0);
});

test("unparseable JSON body: generic message, nothing written", async () => {
  currentFake = freshDb();
  const res = await createOrder.handler({ httpMethod: "POST", headers: { origin: process.env.SITE_ORIGIN }, body: "{not json" });
  assert.ok(res.statusCode >= 400, String(res.statusCode));
  assert.ok(!/Unexpected token|JSON|position/i.test(res.body), res.body);
  assert.strictEqual(currentFake.db.orders.length, 0);
});

test("order page: card checkout takes over only when it says so; otherwise pay-driver confirmation", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "frontend/js/order.js"), "utf8");
  const ok = src.slice(src.indexOf("const checkout = window.CoyoteCheckout;"), src.indexOf("} else {", src.indexOf("const checkout = window.CoyoteCheckout;")));
  assert.ok(/let handled = false;/.test(ok));
  assert.ok(/typeof checkout\.afterOrderCreated === 'function'/.test(ok), "missing Stripe script must not break the order");
  assert.ok(/try \{ handled = await checkout\.afterOrderCreated\(ctx\); \} catch \(err\) \{[^}]*handled = false; \}/.test(ok), "a throwing card step falls back");
  assert.ok(/if \(!handled\) showSuccess\(ctx\);/.test(ok));
  // the amount handed to checkout is the server quote, never the client estimate
  assert.ok(/amount: Number\(result\.data\.estimatedPrice\) \|\| 0/.test(src));
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
  console.log("create-order-gaps: " + tests.length + " passed");
})();
