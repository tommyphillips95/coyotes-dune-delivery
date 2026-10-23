#!/usr/bin/env node
/**
 * charge.refunded without metadata.order_id (e.g. refunded in the Stripe
 * dashboard) finds the order by charge.payment_intent ->
 * orders.stripe_payment_intent_id. If nothing matches, the event is
 * acknowledged (200) and logged; nothing is written and nothing crashes.
 * Stripe/Twilio stubbed; no network, no SMS.
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
delete process.env.TWILIO_ACCOUNT_SID;
let fake = null;
const warns = [];
const realWarn = console.warn;
const realLoad = Module._load;
Module._load = function (request) {
  if (request === "@supabase/supabase-js") return { createClient: () => fake };
  if (request === "stripe") return function Stripe() { return { webhooks: { constructEvent: (raw) => JSON.parse(raw) } }; };
  return realLoad.apply(this, arguments);
};
const webhook = require(path.join(__dirname, "..", "netlify/functions/payment-webhook.js")).handler;

function seed(extra) {
  fake = createFakeSupabase({
    orders: [
      { id: "o1", order_number: "CDD-1", status: "pending", payment_status: "paid", driver_id: null, stripe_payment_intent_id: "pi_A" },
      { id: "o2", order_number: "CDD-2", status: "pending", payment_status: "paid", driver_id: null, stripe_payment_intent_id: "pi_B" },
    ].concat(extra || []),
    order_status_logs: [], dispatch_offers: [], applications: [], sms_logs: [],
  });
}
const refund = (charge) => webhook({
  httpMethod: "POST", headers: { "stripe-signature": "t=1,v1=mock" },
  body: JSON.stringify({ id: "evt_" + Math.random(), type: "charge.refunded", data: { object: Object.assign({ id: "ch_1", amount: 3500, amount_refunded: 3500, refunded: true }, charge) } }),
});
const snap = () => JSON.stringify(fake.db);
const tests = [];
const test = (n, f) => tests.push([n, f]);

test("no metadata: full refund found by payment_intent refunds and cancels that order only", async () => {
  seed();
  const r = await refund({ payment_intent: "pi_B", metadata: {} });
  assert.strictEqual(r.statusCode, 200, r.body);
  const [o1, o2] = fake.db.orders;
  assert.strictEqual(o2.payment_status, "refunded");
  assert.strictEqual(o2.status, "cancelled");
  assert.strictEqual(o1.payment_status, "paid");
  assert.ok(fake.db.order_status_logs.some((l) => l.order_id === "o2" && l.status === "refunded"));
});

test("metadata missing entirely: partial refund by payment_intent is logged against the order", async () => {
  seed();
  const r = await refund({ payment_intent: "pi_A", amount_refunded: 1000, refunded: false });
  assert.strictEqual(r.statusCode, 200, r.body);
  assert.strictEqual(fake.db.orders[0].payment_status, "paid");
  assert.ok(fake.db.order_status_logs.some((l) => l.order_id === "o1" && l.status === "partial_refund"));
});

test("expanded payment_intent object also matches", async () => {
  seed();
  await refund({ payment_intent: { id: "pi_A" }, metadata: {} });
  assert.strictEqual(fake.db.orders[0].payment_status, "refunded");
});

test("stale metadata.order_id (no such order) falls back to payment_intent", async () => {
  seed();
  await refund({ payment_intent: "pi_A", metadata: { order_id: "gone" } });
  assert.strictEqual(fake.db.orders[0].payment_status, "refunded");
});

test("redelivered payment_intent refund is not double-logged", async () => {
  seed();
  await refund({ payment_intent: "pi_A" });
  const n = fake.db.order_status_logs.length;
  const r = await refund({ payment_intent: "pi_A" });
  assert.strictEqual(r.statusCode, 200);
  assert.strictEqual(fake.db.order_status_logs.length, n);
});

for (const [label, charge, extra] of [
  ["unknown payment_intent", { payment_intent: "pi_nope", metadata: {} }],
  ["no metadata and no payment_intent", {}],
  ["unknown order_id and unknown payment_intent", { payment_intent: "pi_nope", metadata: { order_id: "gone" } }],
  ["payment_intent shared by two orders (ambiguous)", { payment_intent: "pi_A" }, [{ id: "o3", status: "pending", payment_status: "paid", stripe_payment_intent_id: "pi_A" }]],
]) {
  test(`${label}: acknowledged 200, logged, nothing written`, async () => {
    seed(extra);
    const before = snap();
    warns.length = 0; console.warn = (...a) => warns.push(a.join(" "));
    let r;
    try { r = await refund(charge); } finally { console.warn = realWarn; }
    assert.strictEqual(r.statusCode, 200, r.body);
    assert.strictEqual(JSON.parse(r.body).received, true);
    assert.strictEqual(snap(), before);
    assert.ok(warns.some((w) => /no matching order/i.test(w)), "logged: " + warns.join(" | "));
  });
}

(async () => {
  let failed = 0;
  console.log("refund-by-payment-intent.test.js");
  for (const [n, f] of tests) {
    try { await f(); console.log("  ok - " + n); }
    catch (e) { failed++; console.error("  FAIL - " + n + "\n    " + String(e.message || e).split("\n")[0]); }
  }
  Module._load = realLoad;
  if (failed) { console.error(`refund-by-payment-intent: ${failed} failed`); process.exit(1); }
  console.log(`refund-by-payment-intent: ${tests.length} passed`);
})();
