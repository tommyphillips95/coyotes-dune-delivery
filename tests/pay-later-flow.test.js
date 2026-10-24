#!/usr/bin/env node
/**
 * Pay Later (skip card) customer path: cancel wires to the pay-driver success
 * copy, and Pay Later is disabled while a card confirm is in flight so it
 * cannot race showSuccess against an in-progress PaymentIntent.
 */
"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const ROOT = path.join(__dirname, "..");
const sp = fs.readFileSync(path.join(ROOT, "frontend/js/stripe-payment.js"), "utf8");

const tests = [];
const test = (n, f) => tests.push([n, f]);

function fnBody(name) {
  const s = sp.indexOf(`function ${name}(`);
  assert.ok(s > -1, name);
  const next = [
    sp.indexOf("\n    function ", s + 10),
    sp.indexOf("\n    async function ", s + 10),
  ].filter((i) => i > -1);
  return sp.slice(s, next.length ? Math.min(...next) : undefined);
}

test("Pay Later button calls showPaymentSkippedSuccess", () => {
  const bind = sp.slice(sp.indexOf("paymentCancelBtn"), sp.indexOf("showPaymentSkippedSuccess") + 80);
  assert.match(bind, /getElementById\('paymentCancelBtn'\)/);
  assert.match(bind, /showPaymentSkippedSuccess\(\)/);
});

test("skipped success: Order Confirmed + pay driver cash/card copy", () => {
  const body = fnBody("showPaymentSkippedSuccess");
  assert.match(body, /title:\s*'Order Confirmed'/);
  assert.match(body, /pay cash or card to the driver/i);
  assert.match(body, /finish\(/);
});

test("finish routes through CoyoteOrder.showSuccess with the order number", () => {
  const body = fnBody("finish");
  assert.match(body, /CoyoteOrder\.showSuccess/);
  assert.match(body, /orderNumber:\s*currentOrderNumber/);
  assert.match(body, /paymentFormContainer\)\s*paymentFormContainer\.remove\(\)/);
});

test("setPaymentLoading disables Pay Later as well as Pay Now", () => {
  const body = fnBody("setPaymentLoading");
  assert.match(body, /paymentSubmitBtn\.disabled = isLoading/);
  assert.match(body, /paymentCancelBtn/);
  assert.match(body, /cancelBtn\.disabled = isLoading/);
});

(async () => {
  let failed = 0;
  for (const [n, f] of tests) {
    try { await f(); console.log("ok - " + n); }
    catch (e) { failed++; console.log("not ok - " + n + "\n  " + e.message); }
  }
  console.log(`${tests.length - failed}/${tests.length} passed`);
  process.exit(failed ? 1 : 0);
})();
