#!/usr/bin/env node
/**
 * payment-webhook payment_intent.succeeded redelivered or out of order:
 * a late "succeeded" never undoes a refund (no re-dispatch), and a redelivery
 * of the same intent doesn't log a second payment. Stripe mocked; no network.
 */
"use strict";
const assert = require("assert");
const path = require("path");
const Module = require("module");
const { createFakeSupabase } = require("./helpers/fake-supabase");

process.env.STRIPE_SECRET_KEY = "sk_test_mocked_not_a_real_key";
process.env.STRIPE_WEBHOOK_SECRET = "whsec_mocked";
process.env.SUPABASE_URL = "https://fake.supabase.test";
process.env.SUPABASE_SERVICE_KEY = "fake-service-key";
delete process.env.WEATHER_SHUTDOWN;

let fake = null;
const realLoad = Module._load;
Module._load = function (request) {
  if (request === "@supabase/supabase-js") return { createClient: () => fake };
  if (request === "stripe") return function Stripe() { return { webhooks: { constructEvent: (raw) => JSON.parse(raw) } }; };
  return realLoad.apply(this, arguments);
};
const ROOT = path.join(__dirname, "..");
const dispatch = require(path.join(ROOT, "netlify/functions/dispatch.js"));
let dispatched = 0;
dispatch.offerNext = async () => { dispatched += 1; return { offered: false, reason: "test" }; };
const webhook = require(path.join(ROOT, "netlify/functions/payment-webhook.js")).handler;

const db = (order) => createFakeSupabase({
  orders: [Object.assign({ id: "o1", status: "pending", payment_status: "pending", stripe_payment_intent_id: "pi_1", final_price: null }, order)],
  order_status_logs: [], dispatch_offers: [], applications: [],
});
const send = (type, obj) => webhook({
  httpMethod: "POST", headers: { "stripe-signature": "t=1,v1=mock" },
  body: JSON.stringify({ id: "evt_" + Math.random(), type, data: { object: obj } }),
});
const succeeded = (id) => send("payment_intent.succeeded", { id: id || "pi_1", amount_received: 3500, metadata: { order_id: "o1" } });
const refunded = () => send("charge.refunded", { id: "ch_1", amount: 3500, amount_refunded: 3500, refunded: true, metadata: { order_id: "o1" } });
const order = () => fake.db.orders[0];
const paidLogs = () => fake.db.order_status_logs.filter((l) => l.status === "paid");

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test("first succeeded marks paid, logs once and dispatches", async () => {
  fake = db(); dispatched = 0;
  const res = await succeeded();
  assert.strictEqual(res.statusCode, 200, res.body);
  assert.strictEqual(order().payment_status, "paid");
  assert.strictEqual(order().final_price, 35);
  assert.strictEqual(paidLogs().length, 1);
  assert.strictEqual(dispatched, 1);
});

test("succeeded redelivered after a full refund leaves the order refunded and dispatches no driver", async () => {
  fake = db(); dispatched = 0;
  await succeeded();
  await refunded();
  assert.strictEqual(order().payment_status, "refunded");
  const res = await succeeded();
  assert.strictEqual(res.statusCode, 200, res.body);
  assert.strictEqual(JSON.parse(res.body).ignored, "already_refunded");
  assert.strictEqual(order().payment_status, "refunded");
  assert.strictEqual(paidLogs().length, 1);
  assert.strictEqual(dispatched, 1);
});

test("refund processed before succeeded arrives: order stays refunded", async () => {
  fake = db({ payment_status: "refunded" }); dispatched = 0;
  await succeeded();
  assert.strictEqual(order().payment_status, "refunded");
  assert.strictEqual(paidLogs().length, 0);
  assert.strictEqual(dispatched, 0);
});

test("same intent redelivered: no second 'paid' log; dispatch may retry (it is idempotent)", async () => {
  fake = db(); dispatched = 0;
  await succeeded();
  const res = await succeeded();
  assert.strictEqual(res.statusCode, 200, res.body);
  assert.strictEqual(JSON.parse(res.body).duplicate, true);
  assert.strictEqual(paidLogs().length, 1);
  assert.strictEqual(order().payment_status, "paid");
});

test("a different intent succeeding on a paid order is still recorded with the second-payment warning", async () => {
  fake = db(); dispatched = 0;
  await succeeded("pi_1");
  await succeeded("pi_2");
  assert.strictEqual(paidLogs().length, 2);
  assert.ok(/WARNING: pi_2 is not the order's current PaymentIntent pi_1/.test(paidLogs()[1].note), paidLogs()[1].note);
});

(async () => {
  let failed = 0;
  for (const [name, fn] of tests) {
    try { await fn(); console.log("ok -", name); }
    catch (err) { failed += 1; console.error("not ok -", name); console.error(err && err.stack ? err.stack : err); }
  }
  if (failed) process.exit(1);
  console.log("webhook-redelivery: " + tests.length + " passed");
})();
