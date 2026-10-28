#!/usr/bin/env node
/**
 * create-payment-intent reuses ONE Stripe customer per our customer record
 * (orders.customer_id), never chosen by the unverified typed email.
 * Stripe is fully mocked (no network, no keys). Supabase is the in-memory fake.
 */
"use strict";
const assert = require("assert");
const path = require("path");
const Module = require("module");
const { createFakeSupabase } = require("./helpers/fake-supabase");

process.env.JWT_SECRET = process.env.JWT_SECRET || "test-jwt-secret";
process.env.STRIPE_SECRET_KEY = "sk_test_mocked_not_a_real_key";
process.env.SUPABASE_URL = "https://fake.supabase.test";
process.env.SUPABASE_SERVICE_KEY = "fake-service-key";
process.env.SITE_ORIGIN = "https://coyote-dune-delivery.netlify.app";

let fake = null;
let stripeMock = null;
function newStripeMock(opts) {
  opts = opts || {};
  const m = { created: [], intents: [], retrieved: [], customers: {}, n: 0 };
  Object.assign(m.customers, opts.existing || {});
  m.api = {
    customers: {
      async retrieve(id) {
        m.retrieved.push(id);
        if (opts.retrieveError) throw opts.retrieveError;
        const c = m.customers[id];
        if (!c) { const e = new Error("No such customer: " + id); e.code = "resource_missing"; e.statusCode = 404; throw e; }
        return c;
      },
      async create(params, options) {
        m.created.push({ params, options });
        const id = "cus_new_" + (++m.n);
        m.customers[id] = { id, email: params.email };
        return m.customers[id];
      },
    },
    paymentIntents: {
      async create(params) {
        const pi = { id: "pi_" + (m.intents.length + 1), client_secret: "pi_secret_" + (m.intents.length + 1), params };
        m.intents.push(pi);
        return pi;
      },
      async retrieve(id) { return m.intents.find((p) => p.id === id); },
    },
  };
  return m;
}

const realLoad = Module._load;
Module._load = function (request) {
  if (request === "@supabase/supabase-js") return { createClient: () => fake };
  if (request === "stripe") return function Stripe() { return stripeMock.api; };
  return realLoad.apply(this, arguments);
};

const handler = require(path.join(__dirname, "..", "netlify/functions/create-payment-intent.js")).handler;
const pay = (order_id, customer_email) => handler({
  httpMethod: "POST", headers: { Authorization: "Bearer " + require("jsonwebtoken").sign({ role: "customer", order_id }, process.env.JWT_SECRET) }, body: JSON.stringify({ order_id, customer_email }),
});
const order = (id, customer_id, extra) => Object.assign({ id, order_number: "CDD-" + id, status: "pending", estimated_price: 35, payment_status: "pending", stripe_payment_intent_id: null, customer_id }, extra || {});

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test("returning customer without email on file: one Stripe customer across orders", async () => {
  fake = createFakeSupabase({
    customers: [{ id: "cust-a", phone: "3615550100", email: null, stripe_customer_id: null }],
    orders: [order("o1", "cust-a"), order("o2", "cust-a")],
    order_status_logs: [],
  });
  stripeMock = newStripeMock();
  const r1 = await pay("o1", "a@example.com");
  const r2 = await pay("o2", "a.other@example.com");
  assert.strictEqual(r1.statusCode, 200, r1.body);
  assert.strictEqual(r2.statusCode, 200, r2.body);
  assert.strictEqual(stripeMock.created.length, 1, "Stripe customer created once");
  assert.strictEqual(fake.db.customers[0].stripe_customer_id, "cus_new_1", "saved on our customer row");
  assert.deepStrictEqual(stripeMock.intents.map((p) => p.params.customer), ["cus_new_1", "cus_new_1"]);
  assert.deepStrictEqual(fake.db.orders.map((o) => o.stripe_customer_id), ["cus_new_1", "cus_new_1"]);
});

test("typing someone else's email never attaches the payment to their Stripe customer", async () => {
  fake = createFakeSupabase({
    customers: [
      { id: "cust-victim", phone: "3615550199", email: "victim@example.com", stripe_customer_id: "cus_victim" },
      { id: "cust-a", phone: "3615550100", email: null, stripe_customer_id: null },
    ],
    orders: [order("o1", "cust-a")],
    order_status_logs: [],
  });
  stripeMock = newStripeMock({ existing: { cus_victim: { id: "cus_victim" } } });
  const res = await pay("o1", "victim@example.com");
  assert.strictEqual(res.statusCode, 200, res.body);
  const used = stripeMock.intents[0].params.customer;
  assert.notStrictEqual(used, "cus_victim");
  assert.ok(!stripeMock.retrieved.includes("cus_victim"), "victim's Stripe customer not even looked up");
  assert.strictEqual(fake.db.customers[0].stripe_customer_id, "cus_victim", "victim row untouched");
  assert.strictEqual(fake.db.customers[1].stripe_customer_id, used, "saved on the ordering customer only");
});

test("stored Stripe id is reused when it still exists (no new customer)", async () => {
  fake = createFakeSupabase({
    customers: [{ id: "cust-a", stripe_customer_id: "cus_keep" }],
    orders: [order("o1", "cust-a")], order_status_logs: [],
  });
  stripeMock = newStripeMock({ existing: { cus_keep: { id: "cus_keep" } } });
  const res = await pay("o1", "a@example.com");
  assert.strictEqual(res.statusCode, 200, res.body);
  assert.strictEqual(stripeMock.created.length, 0);
  assert.strictEqual(stripeMock.intents[0].params.customer, "cus_keep");
});

test("stored id deleted in Stripe ({deleted:true}) or missing (resource_missing): create + save replacement", async () => {
  for (const existing of [{ cus_gone: { id: "cus_gone", deleted: true } }, {}]) {
    fake = createFakeSupabase({
      customers: [{ id: "cust-a", stripe_customer_id: "cus_gone" }],
      orders: [order("o1", "cust-a")], order_status_logs: [],
    });
    stripeMock = newStripeMock({ existing });
    const origWarn = console.warn; console.warn = () => {};
    let res;
    try { res = await pay("o1", "a@example.com"); } finally { console.warn = origWarn; }
    assert.strictEqual(res.statusCode, 200, res.body);
    assert.strictEqual(stripeMock.created.length, 1);
    assert.strictEqual(stripeMock.created[0].options.idempotencyKey, "cdd-customer-cust-a-cus_gone");
    assert.strictEqual(fake.db.customers[0].stripe_customer_id, "cus_new_1");
    assert.strictEqual(stripeMock.intents[0].params.customer, "cus_new_1");
  }
});

test("other Stripe errors on retrieve are not papered over: generic 500, no customer/intent created", async () => {
  fake = createFakeSupabase({
    customers: [{ id: "cust-a", stripe_customer_id: "cus_keep" }],
    orders: [order("o1", "cust-a")], order_status_logs: [],
  });
  const e = new Error("Stripe is down"); e.statusCode = 503;
  stripeMock = newStripeMock({ retrieveError: e });
  const origErr = console.error; console.error = () => {};
  let res;
  try { res = await pay("o1", "a@example.com"); } finally { console.error = origErr; }
  assert.strictEqual(res.statusCode, 500);
  assert.ok(!/Stripe is down/.test(res.body), "no internal error text");
  assert.strictEqual(stripeMock.created.length, 0);
  assert.strictEqual(stripeMock.intents.length, 0);
  assert.strictEqual(fake.db.customers[0].stripe_customer_id, "cus_keep");
});

test("new Stripe customer uses a per-record idempotency key (concurrent tabs share one)", async () => {
  fake = createFakeSupabase({
    customers: [{ id: "cust-a", stripe_customer_id: null }],
    orders: [order("o1", "cust-a")], order_status_logs: [],
  });
  stripeMock = newStripeMock();
  await pay("o1", "a@example.com");
  assert.strictEqual(stripeMock.created[0].options.idempotencyKey, "cdd-customer-cust-a-new");
  assert.strictEqual(stripeMock.created[0].params.metadata.customer_id, "cust-a");
});

test("PaymentIntent never uses saved payment methods; response exposes no customer or ephemeral key", async () => {
  fake = createFakeSupabase({
    customers: [{ id: "cust-a", stripe_customer_id: "cus_keep" }],
    orders: [order("o1", "cust-a")], order_status_logs: [],
  });
  stripeMock = newStripeMock({ existing: { cus_keep: { id: "cus_keep" } } });
  const res = await pay("o1", "a@example.com");
  const p = stripeMock.intents[0].params;
  for (const k of ["setup_future_usage", "payment_method", "off_session", "confirm"]) assert.ok(!(k in p), k);
  const out = JSON.parse(res.body);
  assert.ok(!("customer" in out) && !("ephemeral_key" in out) && !/cus_/.test(res.body));
});

test("order without a customer row (legacy) still pays; nothing written to customers", async () => {
  fake = createFakeSupabase({ customers: [], orders: [order("o1", null)], order_status_logs: [] });
  stripeMock = newStripeMock();
  const res = await pay("o1", "a@example.com");
  assert.strictEqual(res.statusCode, 200, res.body);
  assert.strictEqual(stripeMock.created.length, 1);
  assert.strictEqual(stripeMock.created[0].options, undefined);
  assert.strictEqual(fake.db.customers.length, 0);
});

(async () => {
  let failed = 0;
  for (const [name, fn] of tests) {
    try { await fn(); console.log("ok -", name); }
    catch (e) { failed++; console.error("not ok -", name, "\n ", e.message); }
  }
  console.log(`\npayment-customer: ${tests.length - failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
