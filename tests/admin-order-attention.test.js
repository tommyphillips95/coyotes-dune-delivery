#!/usr/bin/env node
// Admin dashboard: can Tommy see the order states #53-#65 write?
// GET /api/admin/orders returns a payment label, "needs attention" flags and
// history from order_status_logs. No network: fake Supabase, real JWTs.
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const Module = require("module");
const jwt = require("jsonwebtoken");
const { createFakeSupabase } = require("./helpers/fake-supabase");
const seed = require("./fixtures/admin-orders-seed");

let fake = null;
const realLoad = Module._load;
Module._load = function (request) {
  if (request === "@supabase/supabase-js") return { createClient: () => fake };
  return realLoad.apply(this, arguments);
};
const SECRET = "test-admin-attention-secret-32b!!";
process.env.JWT_SECRET = SECRET;
process.env.SUPABASE_URL = "http://example.invalid";
process.env.SUPABASE_SERVICE_KEY = "test";
delete process.env.WEATHER_SHUTDOWN; delete process.env.COYOTE_WEATHER_HOLD;
const ROOT = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
const admin = require(path.join(ROOT, "netlify/functions/admin.js"));
const adminToken = jwt.sign({ role: "admin", user: "ops" }, SECRET);
const ev = (token) => ({ httpMethod: "GET", path: "/.netlify/functions/admin/orders", headers: Object.assign({ origin: "https://coyote-dune-delivery.netlify.app" }, token ? { authorization: "Bearer " + token } : {}), body: null });
async function list() {
  const r = await admin.handler(ev(adminToken));
  assert.strictEqual(r.statusCode, 200, r.body);
  const b = JSON.parse(r.body);
  return { body: b, by: Object.fromEntries(b.orders.map((o) => [o.order_number, o])) };
}
const codes = (o) => (o.attention || []).map((a) => a.code);
const tests = [];
const test = (n, f) => tests.push([n, f]);

test("the note texts we match are the ones the functions actually write", () => {
  const src = {
    cpi: read("netlify/functions/create-payment-intent.js"), hook: read("netlify/functions/payment-webhook.js"),
    order: read("netlify/functions/create-order.js"), area: read("netlify/functions/_service-area.js"), dispatch: read("netlify/functions/dispatch.js"),
  };
  assert(/succeeded but the order was not marked paid/.test(src.cpi));
  assert(/check Stripe for a second payment/.test(src.hook) && /\(WARNING: /.test(src.hook));
  assert(/`Partial refund: \$\{dollars\(refundedCents\)\} of \$\{dollars\(amount\)\}/.test(src.hook) && /status: "partial_refund"/.test(src.hook));
  assert(/"Payment failed: " \+ failureMessage/.test(src.hook));
  assert(/" Address check: " \+ area\.flags\.join/.test(src.order));
  assert(/Customer picked \$\{town\}, \$\{label\} ZIP \$\{zip\}, and said it is on \$\{sides\.island\}; /.test(src.area));
  assert(/Customer said the \$\{label\} \(ZIP \$\{zip\}\) is in Flour Bluff \/ mainland/.test(src.area));
  assert(/"No online " \+ need \+ " driver available\. Holding for dispatch\."/.test(src.dispatch));
});

test("payment column: every payment_status gets a label (none blank)", async () => {
  fake = createFakeSupabase(seed());
  const { by } = await list();
  const want = { "CDD-OK1": "Paid", "CDD-PART1": "Paid, partly refunded", "CDD-STRIPE1": "Card payment started, not paid", "CDD-FAIL1": "Payment failed",
    "CDD-ADDR1": "No card payment yet", "CDD-REF1": "Refunded", "CDD-PROC1": "Card payment started, not paid" };
  for (const [n, label] of Object.entries(want)) assert.strictEqual(by[n].payment.label, label, n);
  for (const o of Object.values(by)) assert(o.payment && o.payment.label && o.payment.cls, o.order_number);
});

test("needs-attention flags for money, dispatch and address problems", async () => {
  fake = createFakeSupabase(seed());
  const { by } = await list();
  assert.deepStrictEqual(codes(by["CDD-STRIPE1"]), ["stripe_paid_not_marked"]);
  assert.strictEqual(by["CDD-STRIPE1"].attention[0].level, "danger");
  assert.deepStrictEqual(codes(by["CDD-TWICE1"]), ["second_payment"]);
  assert.deepStrictEqual(codes(by["CDD-FAIL1"]), ["payment_failed"]);
  assert(/Your card was declined/.test(by["CDD-FAIL1"].attention[0].text));
  assert.deepStrictEqual(codes(by["CDD-NODRV1"]), ["no_driver"]);
  assert(/No online 4x4 driver/.test(by["CDD-NODRV1"].attention[0].text));
  assert.deepStrictEqual(codes(by["CDD-ADDR1"]), ["address_check"]);
  assert(/78358 isn't mapped to Rockport/.test(by["CDD-ADDR1"].attention[0].text));
  assert.deepStrictEqual(codes(by["CDD-ISLE1"]), ["zip_area"]);
  assert.strictEqual(by["CDD-ISLE1"].attention[0].level, "info");
  assert.deepStrictEqual(codes(by["CDD-PART1"]), ["partial_refund"]);
  assert(/\$10\.00 of \$35\.00/.test(by["CDD-PART1"].attention[0].text));
  for (const n of ["CDD-OK1", "CDD-REF1", "CDD-PROC1"]) assert.deepStrictEqual(codes(by[n]), [], n);
});

test("flags clear when the problem is resolved; closed orders don't nag", async () => {
  const s = seed();
  const at = (h) => `2026-10-18T${h}:00:00.000Z`;
  s.order_status_logs.push({ order_id: "o-nodriver", status: "assigned", note: "Driver accepted auto-offer", changed_by: "d1", created_at: at(20) });
  s.orders.find((o) => o.id === "o-stripe").payment_status = "paid"; // webhook caught up
  Object.assign(s.orders.find((o) => o.id === "o-addr"), { status: "completed" });
  fake = createFakeSupabase(s);
  const { by } = await list();
  assert.strictEqual(by["CDD-NODRV1"].history.length, 3, "the assignment is in the history");
  assert.strictEqual(by["CDD-STRIPE1"].payment.label, "Paid");
  assert.deepStrictEqual(codes(by["CDD-NODRV1"]), []);
  assert.deepStrictEqual(codes(by["CDD-STRIPE1"]), []);
  assert.deepStrictEqual(codes(by["CDD-ADDR1"]), []);
});

test("history: newest first, capped, with who/when; logs failure still lists orders", async () => {
  fake = createFakeSupabase(seed());
  const { by, body } = await list();
  assert.strictEqual(body.logsError, false);
  const h = by["CDD-NODRV1"].history;
  assert.strictEqual(h.length, 2);
  assert(h[0].at > h[1].at);
  assert.strictEqual(h[0].by, "dispatch");
  const f = createFakeSupabase(seed());
  const from = f.from;
  f.from = (t) => {
    const q = from(t);
    if (t !== "order_status_logs") return q;
    q.then = (res) => res({ data: null, error: { message: "permission denied" } });
    return q;
  };
  fake = f;
  const origErr = console.error; console.error = () => {};
  let r; try { r = await list(); } finally { console.error = origErr; }
  assert.strictEqual(r.body.orders.length, 10);
  assert.strictEqual(r.body.logsError, true);
});

test("still admin-only", async () => {
  fake = createFakeSupabase(seed());
  assert.strictEqual((await admin.handler(ev(null))).statusCode, 401);
  const driver = jwt.sign({ role: "driver", driver_id: "d1" }, SECRET);
  assert.strictEqual((await admin.handler(ev(driver))).statusCode, 403);
});

test("dashboard renders payment + flags + history + filter; status text never blank", () => {
  const js = read("frontend/admin/admin.js");
  const html = read("frontend/admin/index.html");
  assert(/<th scope="col">Payment<\/th>/.test(html));
  for (const v of ["all", "attention", "payment", "unpaid"]) assert(new RegExp(`<option value="${v}">`).test(html.slice(html.indexOf('id="orders-filter"'))), v);
  assert(/id="orders-attention-count"[^>]*aria-live="polite"/.test(html));
  assert(/id="orders-alert" href="#orders-section"/.test(html));
  assert(/pay-badge pay-\$\{esc\(pay\.cls\)\}">\$\{esc\(pay\.label\)\}/.test(js));
  assert(/attn attn-\$\{esc\(a\.level\)\}/.test(js) && /\$\{esc\(a\.text\)\}/.test(js), "flags are escaped");
  assert(/<details class="order-history">/.test(js));
  // fmtStatus(null) used to throw and blank the whole table
  const m = /function fmtStatus\(s\) \{([\s\S]*?)\n    \}/.exec(js);
  const fmtStatus = new Function("s", m[1]);
  assert.strictEqual(fmtStatus(null), "unknown");
  assert.strictEqual(fmtStatus("in_progress"), "in progress");
});

test("default 'pending' payment_status without a PaymentIntent is 'No card payment yet'; intent id not sent to the browser", async () => {
  const A = require(path.join(ROOT, "netlify/functions/_order-attention.js"));
  assert.strictEqual(A.payment({ payment_status: "pending" }, []).label, "No card payment yet");
  assert.strictEqual(A.payment({ payment_status: "pending", stripe_payment_intent_id: "pi_x" }, []).label, "Card payment started, not paid");
  const sd = seed();
  sd.orders.push(Object.assign({}, sd.orders.find((o) => o.order_number === "CDD-ADDR1"), { id: "o-default", order_number: "CDD-DEF1", payment_status: "pending" }));
  fake = createFakeSupabase(sd);
  const { by } = await list();
  assert.strictEqual(by["CDD-DEF1"].payment.label, "No card payment yet");
  assert.strictEqual(by["CDD-DEF1"].payment.cls, "none");
  for (const o of Object.values(by)) assert(!("stripe_payment_intent_id" in o), o.order_number);
});

(async () => {
  let failed = 0;
  for (const [n, f] of tests) { try { await f(); console.log("ok - " + n); } catch (e) { failed++; console.error("not ok - " + n + "\n  " + e.message); } }
  if (failed) { console.error(failed + " failed"); process.exit(1); }
  console.log("admin-order-attention tests passed");
})();
