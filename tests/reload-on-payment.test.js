#!/usr/bin/env node
// Reload on the card form: create-order succeeded but the customer has not
// paid yet. The checkout key must survive so re-placing the same order gets the
// same order back (replay) instead of a second unpaid one. It is cleared only
// when the order is finished (showSuccess).
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const Module = require("module");
const { createFakeSupabase } = require("./helpers/fake-supabase");
const root = path.join(__dirname, "..");
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
const C = require(path.join(root, "frontend/js/coastal.js"));
const src = fs.readFileSync(path.join(root, "frontend/js/order.js"), "utf8");

function memStore() { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }; }
let n = 0;
const mkKey = () => "reload-key-" + String(++n).padStart(8, "0") + "-abcdef";
const form = { first_name: "Test", last_name: "Customer", phone: "3615550100", service_type: "ride", passenger_count: 1,
  pickup_address: "1 Beach Access Rd", pickup_city: "Port Aransas", pickup_zip: "78373",
  dropoff_address: "Pin 12", dropoff_city: "Mustang Island", dropoff_zip: "78373" };

// Mirror of order.js: what the create-order success branch does with the key.
const okBranch = src.slice(src.indexOf("if (result.ok) {"), src.indexOf("afterOrderCreated", src.indexOf("if (result.ok) {")));
const clearsOnCreate = /checkoutState\.clear\(\)/.test(okBranch);

async function place(session) {
  const body = session.attemptPayload(Object.assign({}, form, { idempotency_key: session.key() }));
  const r = await createOrder.handler({ httpMethod: "POST", headers: { origin: process.env.SITE_ORIGIN }, body: JSON.stringify(body) });
  const res = { status: r.statusCode, data: JSON.parse(r.body) };
  if (r.statusCode < 300 && clearsOnCreate) session.clear();
  return res;
}

const tests = [];
const test = (name, f) => tests.push([name, f]);

test("create-order success does not clear the key before payment", () => {
  assert.ok(okBranch.length > 0);
  assert.ok(!clearsOnCreate, "key cleared before the customer paid");
  assert.ok(/function showSuccess\(ctx\) \{\s*checkoutState\.clear\(\);/.test(src), "finished order clears the key");
});

test("reload on the card form then Place Order again -> same order, no duplicate", async () => {
  fake = createFakeSupabase({ customers: [], orders: [], order_status_logs: [], sms_logs: [] });
  const store = memStore();
  const first = await place(C.checkoutSession(store, mkKey));
  assert.strictEqual(first.status, 201, JSON.stringify(first.data));
  const again = await place(C.checkoutSession(store, mkKey)); // reloaded page, same tab
  assert.ok(again.status < 300, JSON.stringify(again.data));
  assert.strictEqual(fake.db.orders.length, 1, "second unpaid order created");
  assert.strictEqual(again.data.orderNumber, first.data.orderNumber);
});

test("after the order is finished, the next booking is a new order", async () => {
  fake = createFakeSupabase({ customers: [], orders: [], order_status_logs: [], sms_logs: [] });
  const store = memStore();
  const s = C.checkoutSession(store, mkKey);
  await place(s);
  s.clear(); // showSuccess
  const next = await place(C.checkoutSession(store, mkKey));
  assert.strictEqual(next.status, 201);
  assert.strictEqual(fake.db.orders.length, 2);
});

(async () => {
  let fail = 0;
  for (const [name, f] of tests) {
    try { await f(); console.log("ok - " + name); } catch (e) { fail++; console.log("not ok - " + name + "\n  " + e.message); }
  }
  if (fail) process.exit(1);
})();
