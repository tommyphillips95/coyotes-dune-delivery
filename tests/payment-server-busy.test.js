#!/usr/bin/env node
// create-payment-intent answering 5xx/429 shows a plain "try again" message
// with Retry, not the raw server text ("Failed to create payment intent",
// "Stripe is not configured...") with no way to retry.
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const C = require("../frontend/js/coastal.js");
const sp = fs.readFileSync(path.join(__dirname, "..", "frontend/js/stripe-payment.js"), "utf8");

const tests = [];
const test = (n, f) => tests.push([n, f]);

test("5xx and 429 count as busy; 4xx, 409, network and success do not", () => {
  assert.strictEqual(typeof C.paymentServerBusy, "function");
  for (const st of [500, 502, 503, 504, 429]) assert.strictEqual(C.paymentServerBusy({ ok: false, status: st }), true, st);
  for (const r of [{ ok: false, status: 400 }, { ok: false, status: 403 }, { ok: false, status: 409 }, { ok: false, status: 0, offline: true }, { ok: true, status: 200 }, null]) {
    assert.strictEqual(C.paymentServerBusy(r), false, JSON.stringify(r));
  }
});

test("busy message: plain, says Retry and not charged, no server jargon", () => {
  const m = C.paymentBusyMessage();
  assert.ok(/Retry/.test(m) && /haven't been charged/.test(m));
  assert.ok(!/intent|STRIPE|configured/i.test(m));
});

test("payment step checks busy before the raw-error throw and shows Retry", () => {
  const start = sp.indexOf("async function handlePaymentSubmit(");
  const body = sp.slice(start, sp.indexOf("// ── Show Payment Success", start));
  const busy = body.indexOf("C.paymentServerBusy(piResult)");
  assert.ok(busy > -1, "busy check present");
  assert.ok(busy < body.indexOf("throw new Error(piResult.data?.error"), "before the throw");
  const block = body.slice(busy, body.indexOf("return;", busy));
  assert.ok(/showPaymentError\(C\.paymentBusyMessage\(\)\)/.test(block));
  assert.ok(/retryBtn\.hidden = false/.test(block));
});

test("a failed payment clears the stale 'Setting up / Confirming' status", () => {
  const i = sp.indexOf("console.error('Payment failed:', err);");
  assert.ok(/^\s*say\(''\);/.test(sp.slice(i + 40, i + 80)));
});

(async () => {
  let failed = 0;
  for (const [n, f] of tests) {
    try { await f(); console.log("ok - " + n); } catch (e) { failed++; console.log("not ok - " + n + "\n  " + e.message); }
  }
  console.log(`${tests.length - failed}/${tests.length} passed`);
  process.exit(failed ? 1 : 0);
})();
