#!/usr/bin/env node
/**
 * payment-webhook charge.refunded: partial vs full refunds, idempotent and
 * order-independent (cumulative amount_refunded). Stripe mocked; no network.
 */
"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const Module = require("module");
const { createFakeSupabase } = require("./helpers/fake-supabase");

process.env.STRIPE_SECRET_KEY = "sk_test_mocked_not_a_real_key";
process.env.STRIPE_WEBHOOK_SECRET = "whsec_mocked";
process.env.SUPABASE_URL = "https://fake.supabase.test";
process.env.SUPABASE_SERVICE_KEY = "fake-service-key";

let fake = null;
const realLoad = Module._load;
Module._load = function (request) {
  if (request === "@supabase/supabase-js") return { createClient: () => fake };
  if (request === "stripe") return function Stripe() { return { webhooks: { constructEvent: (raw) => JSON.parse(raw) } }; };
  return realLoad.apply(this, arguments);
};
const ROOT = path.join(__dirname, "..");
const webhook = require(path.join(ROOT, "netlify/functions/payment-webhook.js")).handler;
const C = require(path.join(ROOT, "frontend/js/coastal.js"));

const db = () => createFakeSupabase({
  orders: [{ id: "o1", payment_status: "paid", stripe_payment_intent_id: "pi_1" }],
  order_status_logs: [],
});
const charge = (amount_refunded, extra) => Object.assign({ id: "ch_1", amount: 3500, amount_refunded, refunded: amount_refunded >= 3500, metadata: { order_id: "o1" } }, extra || {});
const refund = (obj) => webhook({
  httpMethod: "POST", headers: { "stripe-signature": "t=1,v1=mock" },
  body: JSON.stringify({ id: "evt_" + Math.random(), type: "charge.refunded", data: { object: obj } }),
});
const logs = () => fake.db.order_status_logs;
const status = () => fake.db.orders[0].payment_status;

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test("partial refund keeps the order paid and logs the running total", async () => {
  fake = db();
  const res = await refund(charge(1000));
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(status(), "paid");
  assert.strictEqual(logs().length, 1);
  assert.strictEqual(logs()[0].status, "partial_refund");
  assert.ok(/Partial refund: \$10\.00 of \$35\.00 refunded so far/.test(logs()[0].note), logs()[0].note);
});

test("redelivered partial refund is not logged twice", async () => {
  fake = db();
  await refund(charge(1000));
  const res = await refund(charge(1000));
  assert.strictEqual(JSON.parse(res.body).duplicate, true);
  assert.strictEqual(logs().length, 1);
});

test("second partial logs the new cumulative; a late older event is ignored", async () => {
  fake = db();
  await refund(charge(1000));
  await refund(charge(2500));
  await refund(charge(1000)); // out of order / redelivered
  assert.deepStrictEqual(logs().map((l) => l.note.match(/\$\d+\.\d\d of/)[0]), ["$10.00 of", "$25.00 of"]);
  assert.strictEqual(status(), "paid");
});

test("full refund (amount_refunded >= amount, or refunded:true) marks refunded once", async () => {
  fake = db();
  await refund(charge(1000));
  await refund(charge(3500));
  await refund(charge(3500)); // redelivery
  assert.strictEqual(status(), "refunded");
  assert.deepStrictEqual(logs().map((l) => l.status), ["partial_refund", "refunded"]);
  assert.ok(/Refund issued: \$35\.00 of \$35\.00 \(full\)/.test(logs()[1].note));
  fake = db();
  await refund(charge(3400, { refunded: true }));
  assert.strictEqual(status(), "refunded", "Stripe's refunded flag wins");
});

test("partial event arriving AFTER the full refund never downgrades or re-logs", async () => {
  fake = db();
  await refund(charge(3500));
  await refund(charge(1000));
  assert.strictEqual(status(), "refunded");
  assert.strictEqual(logs().length, 1);
});

test("refund without order metadata is acknowledged, nothing written", async () => {
  fake = db();
  const res = await refund(charge(1000, { metadata: {} }));
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(logs().length, 0);
  assert.strictEqual(status(), "paid");
});

test("track box payment badge: paid / partly refunded / refunded / not paid / pending", () => {
  assert.deepStrictEqual(C.paymentBadge({ payment_status: "paid" }), { cls: "paid", label: "Paid" });
  assert.deepStrictEqual(C.paymentBadge({ payment_status: "paid", status_logs: [{ status: "paid" }, { status: "partial_refund" }] }), { cls: "paid", label: "Paid (partly refunded)" });
  assert.deepStrictEqual(C.paymentBadge({ payment_status: "refunded" }), { cls: "refunded", label: "Refunded" });
  assert.deepStrictEqual(C.paymentBadge({ payment_status: "failed", stripe_payment_intent_id: "pi_1" }), { cls: "failed", label: "Card payment failed" });
  assert.deepStrictEqual(C.paymentBadge({}), { cls: "pending", label: "Pay your driver" });
  const src = fs.readFileSync(path.join(ROOT, "frontend/js/order.js"), "utf8");
  assert.ok(/CoyoteCoastal\.paymentBadge\(order\)/.test(src), "order.js renders the real payment status (was hard-coded 'Pending')");
  assert.ok(/badge\.textContent = b\.label/.test(src), "text, not innerHTML");
});

(async () => {
  let failed = 0;
  for (const [name, fn] of tests) {
    try { await fn(); console.log("ok -", name); }
    catch (e) { failed++; console.error("not ok -", name, "\n ", e.message); }
  }
  console.log(`\nrefunds: ${tests.length - failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
