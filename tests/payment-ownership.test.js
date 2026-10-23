#!/usr/bin/env node
/**
 * create-payment-intent only starts or replaces a payment for the order's owner:
 * the tracking token for that order, or the phone on its customer record.
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
  customers: [{ id: "cust-a", stripe_customer_id: "cus_a", phone: "(361) 555-0101" }],
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


const jwt = require("jsonwebtoken");
const call = (headers, extra) => cpi({ httpMethod: "POST", headers: headers || {}, body: JSON.stringify(Object.assign({ order_id: "o1", customer_email: "a@example.com" }, extra || {})) });
const bearer = (claims, secret) => ({ Authorization: "Bearer " + jwt.sign(claims, secret || process.env.JWT_SECRET) });
const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const refused = (res) => {
  assert.strictEqual(res.statusCode, 403, res.body);
  const out = JSON.parse(res.body);
  assert.strictEqual(out.code, "not_order_owner");
  assert.ok(!out.client_secret);
  assert.deepStrictEqual(S.calls, [], "Stripe never touched");
  assert.strictEqual(fake.db.orders[0].stripe_payment_intent_id, "pi_old", "intent not replaced");
};

test("no proof (only an order id + typed email): 403, nothing created or replaced", async () => {
  fake = db(); S = mockStripe({ intents: { pi_old: pi("pi_old", "requires_payment_method") } });
  refused(await quiet(() => call()));
});

test("wrong phone, another order's token, forged or expired token: 403", async () => {
  for (const [h, extra] of [
    [{}, { phone: "361-555-9999" }],
    [bearer({ role: "customer", order_id: "o2" }), {}],
    [bearer({ role: "customer", order_id: "o1" }, "not-the-secret"), {}],
    [bearer({ role: "customer", order_id: "o1", exp: Math.floor(Date.now() / 1000) - 60 }), {}],
    [bearer({ role: "driver", order_id: "o1" }), {}],
  ]) {
    fake = db(); S = mockStripe({ intents: { pi_old: pi("pi_old", "requires_payment_method") } });
    refused(await quiet(() => call(h, extra)));
  }
});

test("already-paid status is not revealed without proof", async () => {
  fake = db({ payment_status: "paid" }); S = mockStripe();
  const res = await quiet(() => call());
  assert.strictEqual(res.statusCode, 403);
});

test("tracking token for this order: pays (reuses the open intent)", async () => {
  fake = db(); S = mockStripe({ intents: { pi_old: pi("pi_old", "requires_payment_method") } });
  const res = await quiet(() => call(bearer({ role: "customer", order_id: "o1", order_number: "CDD-1" })));
  assert.strictEqual(res.statusCode, 200, res.body);
  assert.strictEqual(JSON.parse(res.body).client_secret, "pi_old_secret");
});

test("matching phone in any format, no token: pays", async () => {
  for (const phone of ["(361) 555-0101", "3615550101", "+1 361 555 0101"]) {
    fake = db({ stripe_payment_intent_id: null }); S = mockStripe();
    const res = await quiet(() => call({}, { phone }));
    assert.strictEqual(res.statusCode, 200, phone + " " + res.body);
    assert.strictEqual(created().length, 1);
  }
});

test("checkout sends the phone and the order's tracking token", () => {
  const src = require("fs").readFileSync(path.join(__dirname, "..", "frontend/js/stripe-payment.js"), "utf8");
  const call = src.slice(src.indexOf("CoyoteAPI.post('/api/create-payment-intent'"));
  assert.ok(/phone: document\.getElementById\('customerPhone'\)/.test(call.slice(0, 600)));
  assert.ok(/headers: paymentAuthHeaders\(\)/.test(call.slice(0, 800)));
  assert.ok(/C\.getTrackingToken\(currentOrderNumber\)/.test(src), "falls back to the token saved on this device");
});

(async () => {
  let failed = 0;
  for (const [name, fn] of tests) {
    try { await fn(); console.log("ok -", name); }
    catch (e) { failed++; console.error("not ok -", name, "\n ", e.message); }
  }
  console.log(`\npayment-ownership: ${tests.length - failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
