#!/usr/bin/env node
/**
 * create-payment-intent with an existing PaymentIntent: never a second charge.
 * Plus payment-webhook ignoring late events from a replaced intent.
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

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test("succeeded: no new intent; 409 already_paid; unpaid order is reported, not recharged", async () => {
  fake = db(); S = mockStripe({ intents: { pi_old: pi("pi_old", "succeeded") } });
  const res = await quiet(pay);
  assert.strictEqual(res.statusCode, 409, res.body);
  const out = JSON.parse(res.body);
  assert.strictEqual(out.status, "already_paid");
  assert.strictEqual(out.code, "already_paid", "machine-readable code for the checkout");
  assert.strictEqual(out.error, "This order is already paid.", "human message kept");
  assert.ok(!out.client_secret, "no secret handed out");
  assert.deepStrictEqual(ops(), ["retrieve:pi_old"]);
  assert.ok(/succeeded but the order was not marked paid/.test(fake.db.order_status_logs[0].note));
  assert.strictEqual(fake.db.orders[0].payment_status, "pending", "status left to the webhook");
});

test("order already marked paid in our DB: 409 code already_paid, Stripe never called", async () => {
  fake = db({ payment_status: "paid" }); S = mockStripe({ intents: { pi_old: pi("pi_old", "succeeded") } });
  const res = await pay();
  assert.strictEqual(res.statusCode, 409);
  const out = JSON.parse(res.body);
  assert.strictEqual(out.code, "already_paid");
  assert.ok(!out.client_secret);
  assert.deepStrictEqual(S.calls, []);
});

test("processing and requires_capture: no new intent; 409 in_progress", async () => {
  for (const status of ["processing", "requires_capture"]) {
    fake = db(); S = mockStripe({ intents: { pi_old: pi("pi_old", status) } });
    const res = await pay();
    assert.strictEqual(res.statusCode, 409, status);
    assert.strictEqual(JSON.parse(res.body).status, "in_progress", status);
    assert.strictEqual(JSON.parse(res.body).code, "payment_processing", status);
    assert.ok(/already being processed/.test(JSON.parse(res.body).error), status);
    assert.deepStrictEqual(ops(), ["retrieve:pi_old"], status);
  }
});

test("modifiable states with the right amount + currency: reused as-is", async () => {
  for (const status of ["requires_payment_method", "requires_confirmation", "requires_action"]) {
    fake = db(); S = mockStripe({ intents: { pi_old: pi("pi_old", status) } });
    const res = await pay();
    assert.strictEqual(res.statusCode, 200, status);
    const out = JSON.parse(res.body);
    assert.strictEqual(out.client_secret, "pi_old_secret");
    assert.strictEqual(out.status, "existing");
    assert.deepStrictEqual(ops(), ["retrieve:pi_old"], status);
  }
});

test("modifiable state, wrong amount or currency: updated in place, no orphan", async () => {
  for (const [status, amount, currency] of [["requires_payment_method", 3000, "usd"], ["requires_action", 3500, "eur"]]) {
    fake = db(); S = mockStripe({ intents: { pi_old: pi("pi_old", status, amount, currency) } });
    const res = await pay();
    assert.strictEqual(res.statusCode, 200, res.body);
    const out = JSON.parse(res.body);
    assert.strictEqual(out.status, "updated");
    assert.strictEqual(out.client_secret, "pi_old_secret");
    assert.deepStrictEqual(ops(), ["retrieve:pi_old", "update:pi_old"]);
    assert.deepStrictEqual(S.calls[1].params, { amount: 3500, currency: "usd" });
    assert.strictEqual(fake.db.orders[0].stripe_payment_intent_id, "pi_old");
  }
});

test("update fails: old intent canceled BEFORE a fresh one is created and stored", async () => {
  fake = db(); S = mockStripe({ intents: { pi_old: pi("pi_old", "requires_confirmation", 3000) }, updateError: new Error("cannot update") });
  const res = await quiet(pay);
  assert.strictEqual(res.statusCode, 200, res.body);
  assert.deepStrictEqual(ops(), ["retrieve:pi_old", "update:pi_old", "cancel:pi_old", "create:pi_new_1"]);
  assert.strictEqual(created()[0].options.idempotencyKey, "cdd-pi-o1-3500-pi_old");
  assert.strictEqual(fake.db.orders[0].stripe_payment_intent_id, "pi_new_1");
  assert.ok(/replaces pi_old/.test(fake.db.order_status_logs[0].note));
});

test("update AND cancel fail: stop with a generic 500; never two live intents", async () => {
  fake = db(); S = mockStripe({ intents: { pi_old: pi("pi_old", "requires_payment_method", 3000) }, updateError: new Error("no"), cancelError: new Error("now processing") });
  const res = await quiet(pay);
  assert.strictEqual(res.statusCode, 500);
  assert.strictEqual(created().length, 0);
  assert.strictEqual(fake.db.orders[0].stripe_payment_intent_id, "pi_old");
});

test("canceled or missing in Stripe: fresh intent (no cancel call), new key, stored on the order", async () => {
  for (const intents of [{ pi_old: pi("pi_old", "canceled") }, {}]) {
    fake = db(); S = mockStripe({ intents });
    const res = await pay();
    assert.strictEqual(res.statusCode, 200, res.body);
    assert.deepStrictEqual(ops(), ["retrieve:pi_old", "create:pi_new_1"]);
    assert.strictEqual(JSON.parse(res.body).client_secret, "pi_new_1_secret");
    assert.strictEqual(created()[0].options.idempotencyKey, "cdd-pi-o1-3500-pi_old");
    assert.strictEqual(fake.db.orders[0].stripe_payment_intent_id, "pi_new_1");
  }
});

test("other retrieve errors and unknown statuses: generic 500, nothing created", async () => {
  const e = new Error("Stripe down"); e.statusCode = 503;
  for (const opts of [{ retrieveError: e, intents: {} }, { intents: { pi_old: pi("pi_old", "some_future_status") } }]) {
    fake = db(); S = mockStripe(opts);
    const res = await quiet(pay);
    assert.strictEqual(res.statusCode, 500);
    assert.ok(!/Stripe down|some_future_status/.test(res.body));
    assert.strictEqual(created().length, 0);
  }
});

test("first intent: idempotency key varies with amount; #52 guarantees kept", async () => {
  fake = db({ stripe_payment_intent_id: null }); S = mockStripe();
  const res = await pay();
  assert.strictEqual(res.statusCode, 200, res.body);
  const c = created()[0];
  assert.strictEqual(c.options.idempotencyKey, "cdd-pi-o1-3500-first");
  assert.strictEqual(c.params.customer, "cus_a", "Stripe customer from the customer record");
  for (const k of ["setup_future_usage", "payment_method", "off_session", "confirm"]) assert.ok(!(k in c.params), k);
  assert.ok(!/cus_/.test(res.body), "no customer id returned");
  fake = db({ stripe_payment_intent_id: null, estimated_price: 40 }); S = mockStripe();
  await pay();
  assert.strictEqual(created()[0].options.idempotencyKey, "cdd-pi-o1-4000-first");
});

// ── webhook ──
const hook = (type, object) => webhook({
  httpMethod: "POST", headers: { "stripe-signature": "t=1,v1=mock" },
  body: JSON.stringify({ type, data: { object } }),
});
const evPi = (id, extra) => Object.assign({ id, metadata: { order_id: "o1" }, amount_received: 3500 }, extra || {});

test("webhook: late canceled/failed/requires_action from a REPLACED intent is ignored", async () => {
  for (const type of ["payment_intent.canceled", "payment_intent.payment_failed", "payment_intent.requires_action"]) {
    fake = db({ stripe_payment_intent_id: "pi_new_1", payment_status: "pending" }); S = mockStripe();
    const res = await hook(type, evPi("pi_old"));
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(JSON.parse(res.body).ignored, "superseded_or_paid", type);
    assert.strictEqual(fake.db.orders[0].payment_status, "pending", type);
    assert.strictEqual(fake.db.order_status_logs.length, 0, type);
  }
});

test("webhook: a failure event never un-pays a paid order", async () => {
  fake = db({ stripe_payment_intent_id: "pi_new_1", payment_status: "paid" }); S = mockStripe();
  await hook("payment_intent.canceled", evPi("pi_new_1"));
  assert.strictEqual(fake.db.orders[0].payment_status, "paid");
});

test("webhook: canceled for the CURRENT intent still marks the order failed", async () => {
  fake = db({ stripe_payment_intent_id: "pi_new_1" }); S = mockStripe();
  await hook("payment_intent.canceled", evPi("pi_new_1"));
  assert.strictEqual(fake.db.orders[0].payment_status, "failed");
});

test("webhook: succeeded on a non-current intent still marks paid, with a double-payment warning", async () => {
  fake = db({ stripe_payment_intent_id: "pi_new_1" }); S = mockStripe();
  const res = await quiet(() => hook("payment_intent.succeeded", evPi("pi_old")));
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(fake.db.orders[0].payment_status, "paid");
  assert.ok(/WARNING: pi_old is not the order's current PaymentIntent pi_new_1/.test(fake.db.order_status_logs[0].note));
});

(async () => {
  let failed = 0;
  for (const [name, fn] of tests) {
    try { await fn(); console.log("ok -", name); }
    catch (e) { failed++; console.error("not ok -", name, "\n ", e.message); }
  }
  console.log(`\npayment-intent-reuse: ${tests.length - failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
