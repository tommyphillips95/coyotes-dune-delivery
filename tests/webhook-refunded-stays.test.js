#!/usr/bin/env node
/**
 * payment-webhook: failed / canceled / requires_action events never change a
 * refunded order. Stripe mocked; no network.
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
const EVENTS = ["payment_intent.payment_failed", "payment_intent.canceled", "payment_intent.requires_action"];
const pi = (id) => ({ id, metadata: { order_id: "o1" }, last_payment_error: { message: "Card declined" } });

test("refunded order (same intent) stays refunded on failed/canceled/requires_action; nothing logged", async () => {
  for (const type of EVENTS) {
    fake = db({ payment_status: "refunded" });
    const res = await send(type, pi("pi_1"));
    assert.strictEqual(res.statusCode, 200, res.body);
    assert.strictEqual(order().payment_status, "refunded", type);
    assert.strictEqual(fake.db.order_status_logs.length, 0, type);
    assert.strictEqual(JSON.parse(res.body).ignored, "superseded_or_paid", type);
  }
});

test("after a real refund flow, a late canceled event doesn't flip it to failed", async () => {
  fake = db(); dispatched = 0;
  await succeeded();
  await refunded();
  await send("payment_intent.canceled", pi("pi_1"));
  assert.strictEqual(order().payment_status, "refunded");
  assert.ok(!fake.db.order_status_logs.some((l) => l.status === "failed"));
});

test("unpaid order still records a failed payment", async () => {
  fake = db();
  await send("payment_intent.payment_failed", pi("pi_1"));
  assert.strictEqual(order().payment_status, "failed");
});

(async () => {
  let failed = 0;
  for (const [name, fn] of tests) {
    try { await fn(); console.log("ok -", name); }
    catch (err) { failed += 1; console.error("not ok -", name); console.error(err && err.stack ? err.stack : err); }
  }
  if (failed) process.exit(1);
  console.log("webhook-refunded-stays: " + tests.length + " passed");
})();
