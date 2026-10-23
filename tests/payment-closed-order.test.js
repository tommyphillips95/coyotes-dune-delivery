#!/usr/bin/env node
/**
 * A cancelled or refunded order never takes a new card payment, and money that
 * still arrives for a cancelled order is flagged for a refund, not dispatched.
 * Stripe is fully mocked (no network, no keys); Supabase is the in-memory fake.
 */
"use strict";
const assert = require("assert");
const path = require("path");
const Module = require("module");
const { createFakeSupabase } = require("./helpers/fake-supabase");

process.env.JWT_SECRET = process.env.JWT_SECRET || "test-jwt-secret";
process.env.STRIPE_SECRET_KEY = "sk_test_mocked_not_a_real_key";
process.env.STRIPE_WEBHOOK_SECRET = "whsec_mocked";
process.env.SUPABASE_URL = "https://fake.supabase.test";
process.env.SUPABASE_SERVICE_KEY = "fake-service-key";
process.env.SITE_ORIGIN = "https://coyote-dune-delivery.netlify.app";

let fake = null;
let S = null;
function mockStripe(opts) {
  opts = opts || {};
  const m = { calls: [], intents: Object.assign({}, opts.intents || {}), n: 0 };
  const log = (op, id, extra) => m.calls.push(Object.assign({ op, id }, extra || {}));
  m.api = {
    customers: {
      async retrieve(id) { return { id }; },
      async create() { return { id: "cus_new" }; },
    },
    paymentIntents: {
      async retrieve(id) {
        log("retrieve", id);
        if (opts.retrieveError) throw opts.retrieveError;
        const pi = m.intents[id];
        if (!pi) { const e = new Error("No such payment_intent"); e.code = "resource_missing"; e.statusCode = 404; throw e; }
        return Object.assign({}, pi);
      },
      async update(id, params) {
        log("update", id, { params });
        if (opts.updateError) throw opts.updateError;
        Object.assign(m.intents[id], params);
        return Object.assign({}, m.intents[id]);
      },
      async cancel(id) {
        log("cancel", id);
        if (opts.cancelError) throw opts.cancelError;
        m.intents[id].status = "canceled";
        return Object.assign({}, m.intents[id]);
      },
      async create(params, options) {
        const id = "pi_new_" + (++m.n);
        log("create", id, { params, options });
        m.intents[id] = { id, client_secret: id + "_secret", status: "requires_payment_method", amount: params.amount, currency: params.currency };
        return Object.assign({}, m.intents[id]);
      },
    },
    webhooks: { constructEvent: (raw) => JSON.parse(raw) },
  };
  return m;
}

const realLoad = Module._load;
Module._load = function (request) {
  if (request === "@supabase/supabase-js") return { createClient: () => fake };
  if (request === "stripe") return function Stripe() { return S.api; };
  return realLoad.apply(this, arguments);
};

const FN = path.join(__dirname, "..", "netlify/functions");
const cpi = require(path.join(FN, "create-payment-intent.js")).handler;
const webhook = require(path.join(FN, "payment-webhook.js")).handler;

const pi = (id, status, amount, currency) => ({ id, client_secret: id + "_secret", status, amount: amount == null ? 3500 : amount, currency: currency || "usd" });
const db = (orderExtra) => createFakeSupabase({
  customers: [{ id: "cust-a", stripe_customer_id: "cus_a" }],
  orders: [Object.assign({ id: "o1", order_number: "CDD-1", status: "pending", estimated_price: 35, payment_status: "pending", stripe_payment_intent_id: "pi_old", customer_id: "cust-a" }, orderExtra || {})],
  order_status_logs: [],
});
const OWNER = { Authorization: "Bearer " + require("jsonwebtoken").sign({ role: "customer", order_id: "o1", order_number: "CDD-1" }, process.env.JWT_SECRET) };
const pay = () => cpi({ httpMethod: "POST", headers: OWNER, body: JSON.stringify({ order_id: "o1", customer_email: "a@example.com" }) });
const ops = () => S.calls.map((c) => c.op + ":" + c.id);
const created = () => S.calls.filter((c) => c.op === "create");
const quiet = async (fn) => {
  const w = console.warn, e = console.error; console.warn = () => {}; console.error = () => {};
  try { return await fn(); } finally { console.warn = w; console.error = e; }
};

const hook = (type, object) => webhook({
  httpMethod: "POST", headers: { "stripe-signature": "t=1,v1=mock" },
  body: JSON.stringify({ type, data: { object } }),
});
const evPi = (id, extra) => Object.assign({ id, metadata: { order_id: "o1" }, amount_received: 3500 }, extra || {});

const { attention } = require(path.join(FN, "_order-attention.js"));
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test("cancelled order: 409 order_closed, no new intent, open intent cancelled", async () => {
  fake = db({ status: "cancelled" }); S = mockStripe({ intents: { pi_old: pi("pi_old", "requires_payment_method") } });
  const res = await quiet(pay);
  assert.strictEqual(res.statusCode, 409, res.body);
  const out = JSON.parse(res.body);
  assert.strictEqual(out.code, "order_closed");
  assert.strictEqual(out.reason, "cancelled");
  assert.ok(!out.client_secret);
  assert.strictEqual(created().length, 0);
  assert.deepStrictEqual(ops(), ["retrieve:pi_old", "cancel:pi_old"]);
});

test("cancelled order with no intent: 409, Stripe never called", async () => {
  fake = db({ status: "cancelled", stripe_payment_intent_id: null }); S = mockStripe();
  const res = await quiet(pay);
  assert.strictEqual(res.statusCode, 409);
  assert.strictEqual(JSON.parse(res.body).code, "order_closed");
  assert.deepStrictEqual(S.calls, []);
});

test("refunded order: 409 order_closed, no bogus 'succeeded but not marked paid' log", async () => {
  fake = db({ payment_status: "refunded" }); S = mockStripe({ intents: { pi_old: pi("pi_old", "succeeded") } });
  const res = await quiet(pay);
  assert.strictEqual(res.statusCode, 409);
  assert.strictEqual(JSON.parse(res.body).reason, "refunded");
  assert.strictEqual(created().length, 0);
  assert.strictEqual(fake.db.order_status_logs.length, 0);
});

test("pending order still pays normally", async () => {
  fake = db({ stripe_payment_intent_id: null }); S = mockStripe();
  const res = await quiet(pay);
  assert.strictEqual(res.statusCode, 200, res.body);
  assert.strictEqual(created().length, 1);
});

test("webhook: succeeded on a cancelled order is recorded, flagged for refund, not dispatched", async () => {
  fake = db({ status: "cancelled" }); S = mockStripe({ intents: { pi_old: pi("pi_old", "succeeded") } });
  const res = await quiet(() => hook("payment_intent.succeeded", evPi("pi_old")));
  assert.strictEqual(res.statusCode, 200);
  const out = JSON.parse(res.body);
  assert.strictEqual(out.dispatch.offered, false);
  assert.strictEqual(out.dispatch.reason, "order_cancelled");
  assert.strictEqual(fake.db.orders[0].payment_status, "paid");
  const note = fake.db.order_status_logs[0].note;
  assert.ok(/WARNING: paid after the order was cancelled; no driver will be sent\. Refund pi_old in Stripe\./.test(note), note);
  const flags = attention(fake.db.orders[0], fake.db.order_status_logs);
  assert.ok(flags.some((f) => f.code === "paid_after_close" && f.level === "danger"), JSON.stringify(flags));
});

(async () => {
  let failed = 0;
  for (const [name, fn] of tests) {
    try { await fn(); console.log("ok -", name); }
    catch (e) { failed++; console.error("not ok -", name, "\n ", e.message); }
  }
  console.log(`\npayment-closed-order: ${tests.length - failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
