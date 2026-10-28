#!/usr/bin/env node
/**
 * Checkout accessibility: heading order on the card step, focus moves when
 * the visible step changes (card form, decline, success / Pay Later),
 * payment errors take keyboard focus like orderSubmitError, and
 * WCAG AA contrast for the payment error text and the "Paid" badge.
 */
"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const ROOT = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
const sp = read("frontend/js/stripe-payment.js");
const order = read("frontend/js/order.js");

const tests = [];
const test = (n, f) => tests.push([n, f]);
const body = (src, name) => {
  const s = src.indexOf(`function ${name}(`);
  assert.ok(s > -1, name);
  const e = [src.indexOf("\n    function ", s + 10), src.indexOf("\n    async function ", s + 10)].filter((i) => i > -1);
  return src.slice(s, e.length ? Math.min(...e) : undefined);
};
const lum = (hex) => {
  const c = hex.replace("#", "").match(/../g).map((h) => parseInt(h, 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
};
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

test("card step heading is an h2 (page h1 -> h2, no skipped level), same text", () => {
  assert.ok(sp.includes("<h2>Secure Payment</h2>"));
  assert.ok(!sp.includes("<h3>Secure Payment</h3>"));
  assert.ok(sp.includes(".payment-form-container h2 {"), "style follows the heading");
});

test("afterOrderCreated moves focus to the card step heading", () => {
  assert.ok(/focusHeading\(paymentFormContainer[^)]*querySelector\('h2'\)\)/.test(body(sp, "afterOrderCreated")));
});

test("after a failed payment, focus lost to <body> returns to Pay Now", () => {
  const b = body(sp, "handlePaymentSubmit");
  const fin = b.lastIndexOf("finally");
  assert.ok(fin > -1);
  assert.ok(/document\.activeElement === document\.body[\s\S]*?paymentSubmitBtn\.focus\(\)/.test(b.slice(fin)));
  assert.ok(/paymentSubmitBtn\.isConnected/.test(b.slice(fin)), "not after success removed the form");
});

test("showSuccess focuses the confirmation heading", () => {
  const b = body(order, "showSuccess");
  assert.ok(/querySelector\('h2'\)[\s\S]*?setAttribute\('tabindex', '-1'\)[\s\S]*?\.focus\(/.test(b));
  assert.ok(b.indexOf(".focus(") > b.indexOf("classList.add('active')"), "focus after it is visible");
});

test("showPaymentError focuses the alert (tabindex + focus), like orderSubmitError", () => {
  assert.ok(/id="paymentError" tabindex="-1" role="alert"/.test(sp), "markup is focusable");
  const b = body(sp, "showPaymentError");
  assert.ok(/\.focus\(/.test(b), "focus moves to the alert");
  assert.ok(/scrollIntoView/.test(b));
  assert.ok(b.indexOf(".focus(") > b.indexOf("classList.add('visible')"), "focus after it is visible");
});

test("payment error text and Paid badge meet AA 4.5:1", () => {
  const err = sp.match(/\.payment-error \{\s*color: (#[0-9A-Fa-f]{6})/)[1];
  assert.ok(ratio(err, "#FBEFE3") >= 4.5, `${err} ${ratio(err, "#FBEFE3").toFixed(2)}`);
  assert.ok(ratio(err, "#FFFFFF") >= 4.5);
  const badge = sp.match(/<div style="margin-top: 12px; color: (#[0-9A-Fa-f]{6});/)[1];
  assert.ok(ratio(badge, "#FFFFFF") >= 4.5, `${badge} ${ratio(badge, "#FFFFFF").toFixed(2)}`);
});

let failed = 0;
for (const [n, f] of tests) { try { f(); console.log("ok -", n); } catch (e) { failed++; console.log("not ok -", n, "\n ", e.message); } }
if (failed) process.exit(1);
