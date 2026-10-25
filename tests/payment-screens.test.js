#!/usr/bin/env node
/**
 * Checkout "already paid" / "payment processing" / "order closed" screens (#53 409 codes) and
 * the LAUNCH.md Stripe section staying in sync with the code. No network.
 */
"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
const C = require(path.join(ROOT, "frontend/js/coastal.js"));

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test("paymentConflictKind: only a 409 with a known code counts", () => {
  assert.strictEqual(C.paymentConflictKind({ ok: false, status: 409, data: { code: "already_paid", error: "This order is already paid." } }), "already_paid");
  assert.strictEqual(C.paymentConflictKind({ ok: false, status: 409, data: { code: "payment_processing" } }), "payment_processing");
  assert.strictEqual(C.paymentConflictKind({ ok: false, status: 409, data: { code: "order_closed", reason: "cancelled" } }), "order_closed");
  assert.strictEqual(C.paymentConflictKind({ ok: false, status: 409, data: { error: "This order is already paid." } }), null, "message text alone is not trusted");
  assert.strictEqual(C.paymentConflictKind({ ok: false, status: 400, data: { code: "already_paid" } }), null);
  assert.strictEqual(C.paymentConflictKind({ ok: false, status: 409, data: { code: "something_else" } }), null);
  assert.strictEqual(C.paymentConflictKind({ ok: false, status: 409, data: "<html>" }), null);
  assert.strictEqual(C.paymentConflictKind({ ok: true, status: 200, data: { code: "already_paid" } }), null);
  assert.strictEqual(C.paymentConflictKind(null), null);
});

test("orderClosedScreen copy matches create-payment-intent (cancelled + refunded)", () => {
  const c = C.orderClosedScreen("cancelled");
  assert.strictEqual(c.title, "Order Cancelled");
  assert.strictEqual(c.message, "This order was cancelled, so it can't be paid.");
  const r = C.orderClosedScreen("refunded");
  assert.strictEqual(r.title, "Payment Refunded");
  assert.strictEqual(r.message, "This order's payment was refunded, so it can't be paid again.");
  assert.strictEqual(C.orderClosedScreen(null).title, "Order Cancelled");
});

test("paymentStatusKind maps the order row for the read-only status check", () => {
  assert.strictEqual(C.paymentStatusKind({ payment_status: "paid" }), "paid");
  assert.strictEqual(C.paymentStatusKind({ payment_status: "failed" }), "failed");
  assert.strictEqual(C.paymentStatusKind({ payment_status: "refunded" }), "failed");
  assert.strictEqual(C.paymentStatusKind({ payment_status: "pending" }), "processing");
  assert.strictEqual(C.paymentStatusKind({}), "processing");
});

test("CoyoteAPI keeps the JSON body on errors so the code is readable", () => {
  assert.ok(/return \{ ok: false, error: err\.message, status: err\.status \|\| 0, data: err\.data[,\s}]/.test(read("frontend/js/main.js")));
});

const sp = read("frontend/js/stripe-payment.js");
const fnBody = (name) => {
  const start = sp.indexOf(`function ${name}(`);
  assert.ok(start > -1, name);
  const next = sp.indexOf("\n    function ", start + 10);
  const nextAsync = sp.indexOf("\n    async function ", start + 10);
  const ends = [next, nextAsync].filter((i) => i > -1);
  return sp.slice(start, ends.length ? Math.min.apply(null, ends) : undefined);
};

test("payment step branches on the 409 code BEFORE treating it as an error", () => {
  const submit = fnBody("handlePaymentSubmit");
  const branch = submit.indexOf("paymentConflictKind(piResult)");
  assert.ok(branch > -1);
  assert.ok(branch < submit.indexOf("if (!piResult.ok || !piResult.data?.client_secret)"));
  assert.ok(/conflict === 'already_paid'\) \{ showAlreadyPaid\(\); return; \}/.test(submit));
  assert.ok(/conflict === 'payment_processing'\) \{ showPaymentProcessing\(\); return; \}/.test(submit));
  assert.ok(/conflict === 'order_closed'\) \{ showOrderClosed\(piResult\); return; \}/.test(submit), "cancelled/refunded must leave the card form");
  assert.ok(/paymentIntent\.status === 'processing'\) \{[\s\S]*?showPaymentProcessing\(\)/.test(submit), "card 'processing' shows the wait screen, not success");
});

test("already-paid screen: no card form, track link, heading focused", () => {
  const body = fnBody("showAlreadyPaid");
  assert.ok(/finish\(/.test(body), "finish() removes the payment form and shows the confirmation");
  assert.ok(/won't be charged again/.test(body));
  assert.ok(/focusHeading\(/.test(body));
  assert.ok(/if \(paymentFormContainer\) paymentFormContainer\.remove\(\)/.test(fnBody("finish")));
});

test("processing screen: accessible live status, check + track, no card form", () => {
  const body = fnBody("showPaymentProcessing");
  assert.ok(/paymentFormContainer\.remove\(\)/.test(body));
  assert.ok(/role="status" aria-live="polite"/.test(body));
  assert.ok(/aria-labelledby/.test(body));
  assert.ok(/Please don't pay again/.test(body));
  assert.ok(/id="paymentCheckBtn"/.test(body) && /id="paymentStatusTrack"/.test(body));
  assert.ok(/min-height: 48px/.test(body), "tap targets");
  assert.ok(/focusHeading\(/.test(body));
});

test("'Check payment status' is read-only: GET /api/get-orders, never create-payment-intent", () => {
  const body = fnBody("checkPaymentStatus");
  assert.ok(/\/api\/get-orders/.test(body));
  assert.ok(/method: 'GET'/.test(body));
  assert.ok(!/create-payment-intent|confirmCardPayment/.test(body));
  assert.ok(/Bearer ' \+ currentTrackingToken/.test(body));
});

test("order_closed screen: no card form, track link, heading focused, live status", () => {
  const body = fnBody("showOrderClosed");
  assert.ok(/paymentFormContainer\.remove\(\)/.test(body));
  assert.ok(/data-payment-state', 'order_closed'/.test(body));
  assert.ok(/role="status" aria-live="polite"/.test(body));
  assert.ok(/id="paymentStatusTrack"/.test(body));
  assert.ok(/Track this order/.test(body));
  assert.ok(/focusHeading\(/.test(body));
  assert.ok(/min-height: 48px/.test(body), "tap targets");
  assert.ok(/orderClosedScreen/.test(body), "titles/copy come from coastal helper");
  assert.ok(/piResult\.data\.error/.test(body), "prefer server error string when present");
  assert.ok(!/create-payment-intent|confirmCardPayment/.test(body));
});

test("LAUNCH.md webhook events == events payment-webhook.js handles", () => {
  const code = read("netlify/functions/payment-webhook.js");
  const handled = new Set([...code.matchAll(/eventType === "([a-z_.]+)"/g)].map((m) => m[1]));
  const md = read("LAUNCH.md");
  const block = md.split("<!-- stripe-webhook-events:start -->")[1].split("<!-- stripe-webhook-events:end -->")[0];
  const listed = new Set([...block.matchAll(/^- `([a-z_.]+)`/gm)].map((m) => m[1]));
  assert.ok(handled.size >= 5);
  assert.deepStrictEqual([...listed].sort(), [...handled].sort());
});

test("LAUNCH.md Stripe env vars == STRIPE_* the functions read; endpoint path exists", () => {
  const fnDir = path.join(ROOT, "netlify/functions");
  const used = new Set();
  for (const f of fs.readdirSync(fnDir).filter((x) => x.endsWith(".js"))) {
    for (const m of fs.readFileSync(path.join(fnDir, f), "utf8").matchAll(/process\.env\.(STRIPE_[A-Z_]+)/g)) used.add(m[1]);
  }
  const md = read("LAUNCH.md");
  const section = md.split("## Stripe (card payments)")[1].split("\n## ")[0];
  for (const v of used) assert.ok(section.includes("`" + v + "`"), v);
  assert.ok(section.includes("/.netlify/functions/payment-webhook"));
  assert.ok(fs.existsSync(path.join(fnDir, "payment-webhook.js")));
  for (const card of ["4242 4242 4242 4242", "4000 0025 0000 3155", "4000 0000 0000 0002"]) assert.ok(section.includes(card), card);
});

let failed = 0;
for (const [name, fn] of tests) {
  try { fn(); console.log("ok -", name); }
  catch (e) { failed++; console.error("not ok -", name, "\n ", e.message); }
}
console.log(`\npayment-screens: ${tests.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
