#!/usr/bin/env node
// Cancelling an order in admin also cancels its open Stripe PaymentIntent.
// Stripe is mocked; a Stripe failure never blocks the cancel, it warns instead.
const assert = require("assert");
const path = require("path");
const Module = require("module");
const jwt = require("jsonwebtoken");
const { createFakeSupabase } = require("./helpers/fake-supabase");
const seed = require("./fixtures/admin-orders-seed");

let fake = null;
let stripeMode = "ok"; // ok | retrieveFails | cancelFails
const pis = {};
const calls = [];
const realLoad = Module._load;
Module._load = function (request) {
  if (request === "@supabase/supabase-js") return { createClient: () => fake };
  if (request === "twilio") throw new Error("twilio must not load in tests");
  if (request === "stripe") {
    return function Stripe() {
      return { paymentIntents: {
        retrieve: async (id) => { calls.push(["retrieve", id]); if (stripeMode === "retrieveFails") throw Object.assign(new Error("boom"), { type: "StripeConnectionError" }); return pis[id]; },
        cancel: async (id, opts) => { calls.push(["cancel", id, opts]); if (stripeMode === "cancelFails") throw Object.assign(new Error("nope"), { type: "StripeInvalidRequestError" }); pis[id].status = "canceled"; return pis[id]; },
      } };
    };
  }
  return realLoad.apply(this, arguments);
};
const SECRET = "test-admin-cancel-secret-32bytes!!";
process.env.JWT_SECRET = SECRET;
process.env.SUPABASE_URL = "http://example.invalid";
process.env.SUPABASE_SERVICE_KEY = "test";
process.env.STRIPE_SECRET_KEY = "sk_test_mock";
delete process.env.TWILIO_ACCOUNT_SID; delete process.env.TWILIO_AUTH_TOKEN; delete process.env.TWILIO_PHONE_NUMBER;
delete process.env.WEATHER_SHUTDOWN; delete process.env.COYOTE_WEATHER_HOLD;
const ROOT = path.join(__dirname, "..");
const admin = require(path.join(ROOT, "netlify/functions/admin.js"));
const updateOrder = require(path.join(ROOT, "netlify/functions/update-order.js"));
const adminToken = jwt.sign({ role: "admin", user: "ops" }, SECRET);
const H = { origin: "https://coyote-dune-delivery.netlify.app", authorization: "Bearer " + adminToken };
const put = (id, body) => admin.handler({ httpMethod: "PUT", path: "/.netlify/functions/admin/orders/" + id, headers: H, body: JSON.stringify(body) });
const patch = (body) => updateOrder.handler({ httpMethod: "PATCH", path: "/.netlify/functions/update-order", headers: H, body: JSON.stringify(body) });
const B = (r) => JSON.parse(r.body);
const order = (id) => fake.db.orders.find((o) => o.id === id);
const ID = "o-nodriver";
function fresh(piStatus, extra) {
  fake = createFakeSupabase(seed());
  Object.assign(order(ID), { stripe_payment_intent_id: "pi_open1", payment_status: "unpaid" }, extra || {});
  for (const k of Object.keys(pis)) delete pis[k];
  pis.pi_open1 = { id: "pi_open1", status: piStatus };
  calls.length = 0; stripeMode = "ok";
}
const tests = [];
const test = (n, f) => tests.push([n, f]);

test("admin cancel cancels an open PaymentIntent (no warning)", async () => {
  fresh("requires_payment_method");
  const r = await put(ID, { status: "cancelled", confirm: true });
  assert.strictEqual(r.statusCode, 200, r.body);
  assert.strictEqual(order(ID).status, "cancelled");
  assert.strictEqual(pis.pi_open1.status, "canceled");
  assert(calls.some((c) => c[0] === "cancel" && c[1] === "pi_open1"));
  assert.deepStrictEqual(B(r).warnings, []);
});

test("requires_action / requires_capture are cancelled too", async () => {
  for (const s of ["requires_action", "requires_capture", "requires_confirmation"]) {
    fresh(s);
    assert.strictEqual((await put(ID, { status: "cancelled", confirm: true })).statusCode, 200);
    assert.strictEqual(pis.pi_open1.status, "canceled", s);
  }
});

test("Stripe failure doesn't block the cancel; admin gets a warning + log note", async () => {
  for (const mode of ["retrieveFails", "cancelFails"]) {
    fresh("requires_payment_method"); stripeMode = mode;
    const r = await put(ID, { status: "cancelled", confirm: true });
    assert.strictEqual(r.statusCode, 200, r.body);
    assert.strictEqual(order(ID).status, "cancelled");
    const w = B(r).warnings.join(" ");
    assert(/Couldn't cancel the open payment in Stripe/.test(w) && /pi_open1/.test(w), w);
    const log = fake.db.order_status_logs.filter((l) => l.order_id === ID).pop();
    assert(/Couldn't cancel the open payment/.test(log.note));
  }
});

test("legacy PATCH /update-order cancel also cancels the PI and returns warnings", async () => {
  fresh("requires_payment_method");
  let r = await patch({ id: ID, status: "cancelled", confirm: true });
  assert.strictEqual(r.statusCode, 200, r.body);
  assert.strictEqual(pis.pi_open1.status, "canceled");
  fresh("requires_payment_method"); stripeMode = "cancelFails";
  r = await patch({ id: ID, status: "cancelled", confirm: true });
  assert.strictEqual(r.statusCode, 200);
  assert(/Couldn't cancel/.test(B(r).warnings.join(" ")));
});

test("paid / succeeded orders: no cancel call, refund warning", async () => {
  fresh("succeeded", { payment_status: "paid" });
  let r = await put(ID, { status: "cancelled", confirm: true });
  assert.strictEqual(r.statusCode, 200);
  assert(!calls.some((c) => c[0] === "cancel"));
  assert(/refund/i.test(B(r).warnings.join(" ")));
  fresh("succeeded");
  r = await put(ID, { status: "cancelled", confirm: true });
  assert(!calls.some((c) => c[0] === "cancel"));
  assert(/refund/i.test(B(r).warnings.join(" ")));
});

test("no PI / already canceled / non-cancel changes: Stripe untouched or no-op", async () => {
  fresh("canceled");
  let r = await put(ID, { status: "cancelled", confirm: true });
  assert.deepStrictEqual(B(r).warnings, []);
  assert(!calls.some((c) => c[0] === "cancel"));
  fresh("requires_payment_method", { stripe_payment_intent_id: null });
  r = await put(ID, { status: "cancelled", confirm: true });
  assert.strictEqual(r.statusCode, 200); assert.strictEqual(calls.length, 0);
  fresh("requires_payment_method");
  r = await put(ID, { status: "cancelled" }); // no confirm -> 400, nothing cancelled
  assert.strictEqual(r.statusCode, 400); assert.strictEqual(calls.length, 0);
});

(async () => {
  let failed = 0;
  for (const [n, f] of tests) {
    try { await f(); console.log("ok -", n); } catch (e) { failed++; console.log("not ok -", n, "\n ", e && e.message); }
  }
  if (failed) { console.log(`${failed} failed`); process.exit(1); }
  console.log(`all ${tests.length} passed`);
})();
