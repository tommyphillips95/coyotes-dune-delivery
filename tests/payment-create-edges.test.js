#!/usr/bin/env node
/**
 * High-value create-payment-intent + Stripe Elements edges not covered elsewhere:
 * - unconfigured Stripe never names env vars in the JSON body;
 * - invalid JSON body is a clean 500 (no SyntaxError / position leak);
 * - missing order_id / email is 400 with required fields;
 * - card decline keeps Retry hidden (only connection errors offer Retry).
 */
"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const Module = require("module");
const { createFakeSupabase } = require("./helpers/fake-supabase");

process.env.JWT_SECRET = process.env.JWT_SECRET || "test-jwt-secret-payment-edges!!";
process.env.SUPABASE_URL = "https://fake.supabase.test";
process.env.SUPABASE_SERVICE_KEY = "fake-service-key";
process.env.SITE_ORIGIN = "https://coyote-dune-delivery.netlify.app";

let fake = null;
let S = null;
function mockStripe() {
  const m = { calls: [], intents: {}, n: 0 };
  m.api = {
    customers: { async retrieve(id) { return { id }; }, async create() { return { id: "cus_new" }; } },
    paymentIntents: {
      async retrieve() { const e = new Error("missing"); e.code = "resource_missing"; throw e; },
      async create(params) {
        const id = "pi_new_" + (++m.n);
        m.intents[id] = { id, client_secret: id + "_secret", status: "requires_payment_method", amount: params.amount };
        return Object.assign({}, m.intents[id]);
      },
      async update() {}, async cancel() {},
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
// Require after mocks are installed.
delete require.cache[require.resolve(path.join(FN, "create-payment-intent.js"))];
delete require.cache[require.resolve(path.join(FN, "_stripe.js"))];
const cpi = require(path.join(FN, "create-payment-intent.js")).handler;
const jwt = require("jsonwebtoken");
const OWNER = { Authorization: "Bearer " + jwt.sign({ role: "customer", order_id: "o1", order_number: "CDD-1" }, process.env.JWT_SECRET) };
const quiet = async (fn) => {
  const w = console.warn, e = console.error; console.warn = () => {}; console.error = () => {};
  try { return await fn(); } finally { console.warn = w; console.error = e; }
};

const tests = [];
const test = (n, f) => tests.push([n, f]);

test("Stripe unset: 500 with a plain message, no env var names in the body", async () => {
  const prev = process.env.STRIPE_SECRET_KEY;
  delete process.env.STRIPE_SECRET_KEY;
  // getStripe caches? re-require _stripe / cpi
  delete require.cache[require.resolve(path.join(FN, "_stripe.js"))];
  delete require.cache[require.resolve(path.join(FN, "create-payment-intent.js"))];
  const handler = require(path.join(FN, "create-payment-intent.js")).handler;
  const res = await quiet(() => handler({
    httpMethod: "POST", headers: OWNER,
    body: JSON.stringify({ order_id: "o1", customer_email: "a@example.com" }),
  }));
  if (prev !== undefined) process.env.STRIPE_SECRET_KEY = prev;
  else process.env.STRIPE_SECRET_KEY = "sk_test_mocked_not_a_real_key";
  // Restore modules with key set for later tests
  delete require.cache[require.resolve(path.join(FN, "_stripe.js"))];
  delete require.cache[require.resolve(path.join(FN, "create-payment-intent.js"))];
  assert.strictEqual(res.statusCode, 500);
  const body = JSON.parse(res.body);
  assert.match(body.error, /temporarily unavailable|try again/i);
  assert.doesNotMatch(res.body, /STRIPE_SECRET_KEY|environment variable|sk_test/i);
});

test("invalid JSON body: clean 500, no SyntaxError / position leak", async () => {
  process.env.STRIPE_SECRET_KEY = "sk_test_mocked_not_a_real_key";
  delete require.cache[require.resolve(path.join(FN, "_stripe.js"))];
  delete require.cache[require.resolve(path.join(FN, "create-payment-intent.js"))];
  S = mockStripe();
  fake = createFakeSupabase({ customers: [], orders: [], order_status_logs: [] });
  const handler = require(path.join(FN, "create-payment-intent.js")).handler;
  const res = await quiet(() => handler({ httpMethod: "POST", headers: OWNER, body: "{not-json" }));
  assert.strictEqual(res.statusCode, 500);
  assert.deepStrictEqual(JSON.parse(res.body), { error: "Failed to create payment intent" });
  assert.doesNotMatch(res.body, /SyntaxError|position|Unexpected token/i);
});

test("missing order_id or customer_email: 400 naming required fields", async () => {
  process.env.STRIPE_SECRET_KEY = "sk_test_mocked_not_a_real_key";
  delete require.cache[require.resolve(path.join(FN, "_stripe.js"))];
  delete require.cache[require.resolve(path.join(FN, "create-payment-intent.js"))];
  S = mockStripe();
  fake = createFakeSupabase({ customers: [], orders: [], order_status_logs: [] });
  const handler = require(path.join(FN, "create-payment-intent.js")).handler;
  for (const body of [{}, { order_id: "o1" }, { customer_email: "a@example.com" }]) {
    const res = await handler({ httpMethod: "POST", headers: OWNER, body: JSON.stringify(body) });
    assert.strictEqual(res.statusCode, 400, JSON.stringify(body));
    const b = JSON.parse(res.body);
    assert.strictEqual(b.error, "Missing required fields");
    assert.deepStrictEqual(b.required, ["order_id", "customer_email"]);
  }
});

test("Elements decline path: Retry stays hidden; only api_connection_error offers Retry", () => {
  const sp = fs.readFileSync(path.join(__dirname, "..", "frontend/js/stripe-payment.js"), "utf8");
  const start = sp.indexOf("if (confirmError)");
  assert.ok(start > -1);
  const block = sp.slice(start, sp.indexOf("if (paymentIntent.status", start));
  assert.match(block, /api_connection_error/);
  assert.match(block, /retryBtn\.hidden = false/);
  // Decline / other confirmError types throw — catch shows message, does not unhide Retry beforehand
  assert.match(block, /throw new Error\(confirmError\.message\)/);
  // After a non-connection confirmError, Retry must not be forced visible in that branch
  const declineBranch = block.replace(/if \(confirmError\.type === 'api_connection_error'[\s\S]*?return;\s*\}/, "");
  assert.doesNotMatch(declineBranch, /retryBtn\.hidden = false/);
});

(async () => {
  let failed = 0;
  for (const [n, f] of tests) {
    try { await f(); console.log("ok -", n); }
    catch (e) { failed++; console.log("not ok -", n, "\n ", e.message); }
  }
  if (failed) process.exit(1);
  console.log("payment-create-edges: " + tests.length + " passed");
})();
