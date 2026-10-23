#!/usr/bin/env node
/**
 * A full Stripe refund cancels an open order: open offers end, the cancel is
 * logged, and an assigned driver gets the usual driver text (dispatch.sendSMS).
 * A partial refund doesn't cancel. Completed orders stay completed.
 * Stripe and Twilio are stubbed: no network and no live SMS.
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
// Fake Twilio creds so sendSMS reaches the (stubbed) client; nothing real.
process.env.TWILIO_ACCOUNT_SID = "ACtest"; process.env.TWILIO_AUTH_TOKEN = "t"; process.env.TWILIO_PHONE_NUMBER = "+15550000000";
const texts = [];
let fake = null;
const realLoad = Module._load;
Module._load = function (request) {
  if (request === "@supabase/supabase-js") return { createClient: () => fake };
  if (request === "stripe") return function Stripe() { return { webhooks: { constructEvent: (raw) => JSON.parse(raw) } }; };
  if (request === "twilio") return () => ({ messages: { create: async (m) => { texts.push(m); return { sid: "SMfake" }; } } });
  return realLoad.apply(this, arguments);
};
const webhook = require(path.join(__dirname, "..", "netlify/functions/payment-webhook.js")).handler;

function seed(order) {
  return createFakeSupabase({
    orders: [Object.assign({ id: "o1", order_number: "CDD-9", status: "pending", payment_status: "paid", driver_id: null }, order)],
    order_status_logs: [],
    dispatch_offers: [
      { id: "of1", order_id: "o1", driver_id: "d1", status: "offered" },
      { id: "of0", order_id: "o1", driver_id: "d0", status: "declined" },
    ],
    applications: [{ id: "d1", phone: "+15551230000", status: "approved" }],
    sms_logs: [],
  });
}
const refund = (cents) => webhook({
  httpMethod: "POST", headers: { "stripe-signature": "t=1,v1=mock" },
  body: JSON.stringify({ id: "evt_" + Math.random(), type: "charge.refunded", data: { object: { id: "ch_1", amount: 3500, amount_refunded: cents, refunded: cents >= 3500, metadata: { order_id: "o1" } } } }),
});
const o = () => fake.db.orders[0];
const tests = [];
const test = (n, f) => tests.push([n, f]);

test("full refund on a pending order: cancelled, open offer expired, no text", async () => {
  fake = seed(); texts.length = 0;
  assert.strictEqual((await refund(3500)).statusCode, 200);
  assert.strictEqual(o().status, "cancelled");
  assert.strictEqual(o().payment_status, "refunded");
  assert.strictEqual(fake.db.dispatch_offers[0].status, "expired");
  assert.strictEqual(fake.db.dispatch_offers[1].status, "declined", "closed offers untouched");
  assert.ok(fake.db.order_status_logs.some((l) => l.status === "cancelled"));
  assert.strictEqual(texts.length, 0);
});

for (const st of ["assigned", "in_progress"]) {
  test(`full refund on an ${st} order: cancelled and the driver is texted once`, async () => {
    fake = seed({ status: st, driver_id: "d1" }); texts.length = 0;
    await refund(3500);
    await refund(3500); // redelivery: no second cancel or text
    assert.strictEqual(o().status, "cancelled");
    assert.strictEqual(texts.length, 1);
    assert.strictEqual(texts[0].to, "+15551230000");
    assert.ok(/CDD-9 was refunded and cancelled/.test(texts[0].body), texts[0].body);
    assert.strictEqual(fake.db.sms_logs.length, 1);
    assert.strictEqual(fake.db.order_status_logs.filter((l) => l.status === "cancelled").length, 1);
  });
}

test("partial refund does not cancel the order, expire offers or text anyone", async () => {
  fake = seed({ status: "assigned", driver_id: "d1" }); texts.length = 0;
  await refund(1000);
  assert.strictEqual(o().status, "assigned");
  assert.strictEqual(o().payment_status, "paid");
  assert.strictEqual(fake.db.dispatch_offers[0].status, "offered");
  assert.strictEqual(texts.length, 0);
});

test("full refund on a completed order keeps it completed, no text", async () => {
  fake = seed({ status: "completed", driver_id: "d1" }); texts.length = 0;
  await refund(3500);
  assert.strictEqual(o().status, "completed");
  assert.strictEqual(o().payment_status, "refunded");
  assert.strictEqual(texts.length, 0);
});

(async () => {
  let failed = 0;
  console.log("refund-cancels-order.test.js");
  for (const [n, f] of tests) {
    try { await f(); console.log("  ok - " + n); }
    catch (e) { failed++; console.error("  FAIL - " + n + "\n    " + (e.stack || e.message)); }
  }
  Module._load = realLoad;
  if (failed) { console.error(`refund-cancels-order: ${failed} failed`); process.exit(1); }
  console.log(`refund-cancels-order: ${tests.length} passed`);
})();
