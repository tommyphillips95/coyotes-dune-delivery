#!/usr/bin/env node
/**
 * Recovery UX on /order/ and /track/:
 * - create-order 5xx/429 shows the Retry button (not only network failures);
 * - unexpected PaymentIntent status never prints "Payment status: …";
 * - empty /track/ lead does not claim the map is already refreshing.
 */
"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const ROOT = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
const orderJs = read("frontend/js/order.js");
const trackHtml = read("frontend/track/index.html");
const trackJs = read("frontend/track/track.js");
const payJs = read("frontend/js/stripe-payment.js");
const C = require(path.join(ROOT, "frontend/js/coastal.js"));

const tests = [];
const test = (n, f) => tests.push([n, f]);

test("paymentServerBusy covers 5xx and 429 (order Retry reuses this)", () => {
  for (const st of [500, 502, 503, 504, 429]) {
    assert.strictEqual(C.paymentServerBusy({ ok: false, status: st }), true, String(st));
  }
  assert.strictEqual(C.paymentServerBusy({ ok: false, status: 400 }), false);
  assert.strictEqual(C.paymentServerBusy({ ok: true, status: 200 }), false);
});

test("submitOrder shows Retry for network OR server-busy failures", () => {
  const start = orderJs.indexOf("function submitOrder");
  assert.ok(start > -1);
  const body = orderJs.slice(start, orderJs.indexOf("\n    function ", start + 10) > -1
    ? orderJs.indexOf("\n    async function payFirstOrder", start)
    : undefined);
  // Fall back: slice a generous window
  const win = orderJs.slice(start, start + 8000);
  assert.ok(/paymentServerBusy\s*\(\s*result\s*\)/.test(win), "uses paymentServerBusy");
  assert.ok(/showRetry\(\!\!netKind\s*\|\|\s*\(\!\!serverBusy/.test(win)
    || /showRetry\(\!\!netKind \|\| \(\!\!serverBusy && !result\.ok\)\)/.test(win),
    "Retry on net OR busy: " + (win.match(/showRetry\([^)]+\)/) || [])[0]);
});

test("unexpected PaymentIntent status: friendly copy, never 'Payment status:'", () => {
  assert.doesNotMatch(payJs, /Payment status:\s*\$\{/);
  assert.doesNotMatch(payJs, /throw new Error\(`Payment status:/);
  assert.match(payJs, /Unexpected PaymentIntent status/);
  assert.match(payJs, /finish this payment/i);
  assert.match(payJs, /retryBtn\.hidden = false/);
});

test("empty /track/ lead invites lookup; does not claim live refresh yet", () => {
  const lead = trackHtml.match(/<main class="track-page">\s*<h1[^>]*>[\s\S]*?<\/h1>\s*<p>([^<]*)<\/p>/);
  assert.ok(lead, "lead paragraph");
  assert.match(lead[1], /Enter your order number/i);
  assert.match(lead[1], /15 seconds/);
  assert.doesNotMatch(lead[1], /^Live driver location/);
});

test("track UNAVAILABLE / offline copy names Track Order as the recovery action", () => {
  assert.match(trackJs, /Tap Track Order to try again in a minute/);
  assert.match(trackJs, /tap Track Order to try again/);
  assert.doesNotMatch(trackJs, /Please try again in a minute\./);
});

let failed = 0;
for (const [n, f] of tests) {
  try { f(); console.log("ok -", n); }
  catch (e) { failed++; console.log("not ok -", n, "\n ", e.message); }
}
if (failed) process.exit(1);
console.log("order-track-recovery: " + tests.length + " passed");
