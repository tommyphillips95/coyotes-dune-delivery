#!/usr/bin/env node
/**
 * After Place Order (card step / Order Confirmed / payment status panels),
 * the "Book a Ride or Delivery" hero and the secondary "Track an Existing
 * Order" block must hide — they were confusing chrome under the real CTA
 * at 360px (and every width).
 */
"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const ROOT = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
const order = read("frontend/js/order.js");
const sp = read("frontend/js/stripe-payment.js");
const css = read("frontend/css/style.css");
const html = read("frontend/order/index.html");

const tests = [];
const test = (n, f) => tests.push([n, f]);
const body = (src, name) => {
  const s = src.indexOf(`function ${name}(`);
  assert.ok(s > -1, name);
  const e = [src.indexOf("\n    function ", s + 10), src.indexOf("\n    async function ", s + 10)].filter((i) => i > -1);
  return src.slice(s, e.length ? Math.min(...e) : undefined);
};

test("CSS hides form-header + tracking-section under .cc-post-book", () => {
  assert.match(css, /\.form-container\.cc-post-book\s*>\s*\.form-header/);
  assert.match(css, /\.form-container\.cc-post-book\s*>\s*\.tracking-section/);
  assert.match(css, /\.form-container\.cc-post-book[^}]*display:\s*none/);
});

test("order page keeps form-header and trackingSection as direct children of formContainer", () => {
  assert.match(html, /id="formContainer"[\s\S]*?class="form-header"/);
  assert.match(html, /id="formContainer"[\s\S]*?id="trackingSection"/);
  // tracking is after orderSuccess (sibling under formContainer)
  const fc = html.indexOf('id="formContainer"');
  const th = html.indexOf('class="form-header"', fc);
  const ts = html.indexOf('id="trackingSection"', fc);
  const os = html.indexOf('id="orderSuccess"', fc);
  assert.ok(th > fc && os > th && ts > os, "header → success → tracking order");
});

test("showSuccess turns on cc-post-book", () => {
  const b = body(order, "showSuccess");
  assert.match(b, /setPostBookChrome\(true\)/);
});

test("afterOrderCreated (card step) turns on cc-post-book", () => {
  const b = body(sp, "afterOrderCreated");
  assert.match(b, /setPostBookChrome\(true\)/);
});

test("payment processing + order_closed panels turn on cc-post-book", () => {
  assert.match(body(sp, "showPaymentProcessing"), /setPostBookChrome\(true\)/);
  assert.match(body(sp, "showOrderClosed"), /setPostBookChrome\(true\)/);
});

let failed = 0;
for (const [n, f] of tests) {
  try { f(); console.log("ok -", n); }
  catch (e) { failed++; console.log("not ok -", n, "\n ", e.message); }
}
console.log(`confirm-hide-chrome: ${tests.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
