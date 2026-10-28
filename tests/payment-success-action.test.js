#!/usr/bin/env node
/**
 * Card-confirm success + requires_action recovery — gaps next to the denser
 * pay-later / busy / decline / unexpected-status coverage. No live Stripe.
 */
"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const sp = fs.readFileSync(path.join(root, "frontend/js/stripe-payment.js"), "utf8");

const tests = [];
const test = (n, f) => tests.push([n, f]);

function fnBody(name) {
  const start = sp.indexOf("function " + name + "(");
  assert.ok(start > -1, name + " missing");
  const next = sp.indexOf("\n    function ", start + 10);
  const nextAsync = sp.indexOf("\n    async function ", start + 10);
  const ends = [next, nextAsync].filter((i) => i > -1);
  return sp.slice(start, ends.length ? Math.min.apply(null, ends) : undefined);
}

/** Isolate the requires_action arm (stops before the unexpected-status else). */
function requiresActionBlock() {
  const marker = "paymentIntent.status === 'requires_action'";
  const i = sp.indexOf(marker);
  assert.ok(i > -1, "requires_action branch missing");
  const after = sp.slice(i);
  // Closing of this arm is the "} else {" that introduces unexpected status.
  const end = after.indexOf("} else {");
  assert.ok(end > -1, "expected } else { after requires_action");
  return after.slice(0, end);
}

test("showPaymentSuccess: Payment Successful title, thank-you payment copy, Paid badge", () => {
  const body = fnBody("showPaymentSuccess");
  assert.match(body, /title:\s*'Payment Successful!'/);
  assert.match(body, /Thank you for your payment\. Your order is confirmed\./);
  assert.match(body, /Paid \$\$\{currentAmount\.toFixed\(2\)\}/);
  assert.match(body, /paid:\s*true/);
  assert.match(body, /finish\(/);
});

test("requires_action: friendly auth copy, never raw status, Retry offered", () => {
  const block = requiresActionBlock();
  assert.match(block, /Additional authentication is required/);
  assert.doesNotMatch(block, /Payment status:/);
  assert.ok(!/showPaymentError\([^)]*paymentIntent\.status/.test(block), "must not print raw status");
  // Scoped to THIS arm only — unexpected-status Retry must not satisfy this.
  assert.match(block, /retryBtn\.hidden = false/);
  assert.match(block, /say\(''\)/);
  assert.match(block, /\breturn;/);
});

(async () => {
  let failed = 0;
  for (const [n, f] of tests) {
    try { await f(); console.log("ok - " + n); }
    catch (e) { failed++; console.log("not ok - " + n + "\n  " + e.message); }
  }
  console.log((tests.length - failed) + "/" + tests.length + " passed");
  process.exit(failed ? 1 : 0);
})();
