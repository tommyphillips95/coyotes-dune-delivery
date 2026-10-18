#!/usr/bin/env node
// Edit (or reload) after a timed-out create-order: the checkout key is kept
// in sessionStorage until an order succeeds, so the server either creates the
// order once (first try never arrived) or names the order the first try made
// (422 checkout_changed) instead of creating a second one.
// Client = frontend/js/coastal.js checkoutSession/checkoutConflict (what
// order.js uses); server = the real create-order handler on the fake DB.
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const Module = require("module");
const { createFakeSupabase } = require("./helpers/fake-supabase");

const root = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");
for (const k of ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_PHONE_NUMBER", "WEATHER_SHUTDOWN", "COYOTE_WEATHER_HOLD"]) delete process.env[k];
process.env.SUPABASE_URL = "http://example.invalid";
process.env.SUPABASE_SERVICE_KEY = "test";
process.env.SITE_ORIGIN = "https://coyote-dune-delivery.netlify.app";
process.env.JWT_SECRET = "test-secret-at-least-16";
let fake = null;
const realLoad = Module._load;
Module._load = function (request) {
  if (request === "@supabase/supabase-js") return { createClient: () => fake };
  return realLoad.apply(this, arguments);
};
const createOrder = require(path.join(root, "netlify/functions/create-order.js"));
const C = require(path.join(root, "frontend/js/coastal.js"));

function memStore() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), _m: m };
}
let n = 0;
const mkKey = () => "test-key-" + String(++n).padStart(8, "0") + "-abcdef";
const form = (o) => Object.assign({ first_name: "Test", last_name: "Customer", phone: "3615550100", service_type: "ride", passenger_count: 1,
  pickup_address: "1 Beach Access Rd", pickup_city: "Port Aransas", pickup_zip: "78373",
  dropoff_address: "Pin 12", dropoff_city: "Mustang Island", dropoff_zip: "78373" }, o || {});

/** What order.js submitOrder does. mode: "ok" | "never-arrived" (request lost) | "response-lost" (server ran, answer lost). */
async function send(session, fields, mode) {
  const body = session.attemptPayload(Object.assign({}, fields, { idempotency_key: session.key() }));
  if (mode === "never-arrived") return { ok: false, status: 0, timedOut: true, sent: body };
  const r = await createOrder.handler({ httpMethod: "POST", headers: { origin: process.env.SITE_ORIGIN }, body: JSON.stringify(body) });
  if (mode === "response-lost") return { ok: false, status: 0, timedOut: true, sent: body };
  const data = JSON.parse(r.body);
  const result = { ok: r.statusCode < 300, status: r.statusCode, data, sent: body };
  if (result.ok) session.clear(); // order.js: success clears the key
  return result;
}
const tests = [];
const test = (name, f) => tests.push([name, f]);
const fresh = () => { fake = createFakeSupabase({ customers: [], orders: [], order_status_logs: [], sms_logs: [] }); };

test("edit after timeout, first request never arrived -> exactly one order, with the edited details, same key", async () => {
  fresh(); const store = memStore(); const s = C.checkoutSession(store, mkKey);
  const first = await send(s, form(), "never-arrived");
  s.edited();
  const second = await send(s, form({ dropoff_city: "Padre Island", dropoff_zip: "78418" }));
  assert.strictEqual(second.status, 201, JSON.stringify(second.data));
  assert.strictEqual(second.sent.idempotency_key, first.sent.idempotency_key, "edit keeps the key");
  assert.strictEqual(fake.db.orders.length, 1);
  assert.strictEqual(fake.db.orders[0].dropoff_city, "Padre Island");
});

test("edit after timeout, first request DID arrive -> no second order; customer gets the first order's number + tracking", async () => {
  fresh(); const store = memStore(); const s = C.checkoutSession(store, mkKey);
  await send(s, form(), "response-lost");
  assert.strictEqual(fake.db.orders.length, 1);
  s.edited();
  const r = await send(s, form({ passenger_count: 3, special_instructions: "Gate 4" }));
  assert.strictEqual(r.status, 422);
  const conflict = C.checkoutConflict(r);
  assert.strictEqual(conflict.kind, "changed");
  assert.strictEqual(conflict.order.orderNumber, fake.db.orders[0].order_number);
  assert.ok(conflict.order.trackingToken);
  assert.strictEqual(fake.db.orders.length, 1, "no second order");
  assert.strictEqual(fake.db.orders[0].passenger_count, 1, "first order's details are not changed");
  assert.ok(store.getItem(C.CHECKOUT_KEY_STORE), "key kept until the customer chooses");
  // "Place a different order" = fresh key -> a separate, second order on purpose.
  s.clear();
  const other = await send(s, form({ passenger_count: 3 }));
  assert.strictEqual(other.status, 201);
  assert.strictEqual(fake.db.orders.length, 2);
  assert.notStrictEqual(other.sent.idempotency_key, r.sent.idempotency_key);
});

test("reload keeps the key: a resend of the same order after reload replays it (no duplicate)", async () => {
  fresh(); const store = memStore(); const before = C.checkoutSession(store, mkKey);
  const k = before.key();
  await send(before, form(), "response-lost");
  const after = C.checkoutSession(store, mkKey); // page reloaded: new JS state, same tab storage
  assert.strictEqual(after.key(), k);
  const r = await send(after, form());
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  assert.strictEqual(r.data.replayed, true);
  assert.strictEqual(fake.db.orders.length, 1);
  assert.strictEqual(r.data.orderNumber, fake.db.orders[0].order_number);
});

test("success clears the key (sessionStorage too); the next order gets a new one", async () => {
  fresh(); const store = memStore(); const s = C.checkoutSession(store, mkKey);
  const r = await send(s, form());
  assert.strictEqual(r.status, 201);
  assert.strictEqual(store.getItem(C.CHECKOUT_KEY_STORE), null);
  assert.notStrictEqual(C.checkoutSession(store, mkKey).key(), r.sent.idempotency_key);
});

test("plain retry (no edit) resends the identical frozen payload; edit sends new details", () => {
  const s = C.checkoutSession(memStore(), mkKey);
  const a = s.attemptPayload({ idempotency_key: s.key(), schedule: "asap" });
  assert.strictEqual(s.attemptPayload({ idempotency_key: s.key(), schedule: "later" }), a);
  s.edited();
  assert.strictEqual(s.attemptPayload({ idempotency_key: s.key(), schedule: "later" }).schedule, "later");
});

test("other refusals: 409 checkout_used (different phone) reveals nothing; ordinary errors aren't conflicts", async () => {
  fresh(); const s = C.checkoutSession(memStore(), mkKey);
  await send(s, form(), "response-lost");
  s.edited();
  const r = await send(s, form({ phone: "3615559999" }));
  assert.strictEqual(r.status, 409);
  assert.deepStrictEqual(C.checkoutConflict(r), { kind: "used" });
  assert.ok(!/CDD-|token|orderId/.test(JSON.stringify(r.data)));
  assert.strictEqual(C.checkoutConflict({ ok: false, status: 400, data: { error: "x" } }), null);
  assert.strictEqual(C.checkoutConflict({ ok: false, status: 0, timedOut: true }), null);
});

test("storage blocked (private mode) still works in memory; bad stored values are ignored", () => {
  const throwing = { getItem() { throw new Error("denied"); }, setItem() { throw new Error("denied"); }, removeItem() { throw new Error("denied"); } };
  const s = C.checkoutSession(throwing, mkKey);
  const k = s.key(); assert.strictEqual(s.key(), k); s.clear();
  const st = memStore(); st.setItem(C.CHECKOUT_KEY_STORE, "<script>");
  assert.notStrictEqual(C.checkoutSession(st, mkKey).key(), "<script>");
});

test("order page wiring: panel with separate Track / Place a different order, key not reset on edit", () => {
  const js = read("frontend/js/order.js");
  assert(/if \(!result\.ok && showCheckoutConflict\(result\)\) \{/.test(js));
  assert(/function startDifferentOrder\(\) \{\s*checkoutState\.clear\(\);/.test(js));
  assert(!/checkoutKey = null/.test(js), "edits must not drop the key");
  const html = read("frontend/order/index.html");
  const panel = html.slice(html.indexOf('id="firstOrderPanel"'), html.indexOf("</section>", html.indexOf('id="firstOrderPanel"')));
  assert(/id="firstOrderTrack"[^>]*>Track this order</.test(panel));
  assert(/<div class="cc-first-order-new">[\s\S]*id="firstOrderNew">Place a different order</.test(panel), "different order is separated");
  assert(/second, separate order/.test(panel));
  assert(/\.cc-first-order-btn \{[^}]*min-height: 48px/.test(read("frontend/css/coastal.css")));
});

(async () => {
  let failed = 0;
  for (const [name, f] of tests) { try { await f(); console.log("ok - " + name); } catch (e) { failed++; console.error("not ok - " + name + "\n  " + e.message); } }
  if (failed) { console.error(failed + " failed"); process.exit(1); }
  console.log("edit-after-timeout tests passed");
})();
