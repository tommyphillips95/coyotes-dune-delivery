#!/usr/bin/env node
/**
 * On Order Confirmed / Payment Successful at 360px, the primary "Track this
 * order" CTA must sit above the booking summary and next-steps copy — those
 * blocks pushed Track below the fold (~792px on a 640px-tall phone).
 */
"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const ROOT = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(ROOT, "frontend/order/index.html"), "utf8");

const tests = [];
const test = (n, f) => tests.push([n, f]);

function successBlock() {
  const start = html.indexOf('id="orderSuccess"');
  assert.ok(start > -1, "orderSuccess");
  const end = html.indexOf('id="trackingSection"', start);
  return html.slice(start, end > -1 ? end : undefined);
}

test("cc-confirm-actions wraps Track / Home / Book Another", () => {
  const b = successBlock();
  assert.match(b, /id="ccConfirmActions"/);
  assert.match(b, /id="ccConfirmActions"[\s\S]*?id="ccTrackLink"/);
  assert.match(b, /id="ccConfirmActions"[\s\S]*?Back to Home/);
  assert.match(b, /id="ccConfirmActions"[\s\S]*?Book Another/);
});

test("actions come after orderIdDisplay and before summary + next-steps", () => {
  const b = successBlock();
  const id = b.indexOf('id="orderIdDisplay"');
  const act = b.indexOf('id="ccConfirmActions"');
  const sum = b.indexOf('id="ccConfirmSummary"');
  const next = b.indexOf('id="ccNextSteps"');
  const track = b.indexOf('id="ccTrackLink"');
  assert.ok(id > -1 && act > -1 && sum > -1 && next > -1 && track > -1);
  assert.ok(id < act, "order id before actions");
  assert.ok(act < sum, "actions before summary");
  assert.ok(sum < next, "summary before next-steps");
  assert.ok(act < track && track < sum, "Track link inside actions, before summary");
});

test("CSS defines .cc-confirm-actions layout", () => {
  assert.match(html, /\.cc-confirm-actions\s*\{[^}]*display:\s*flex/s);
});

let failed = 0;
for (const [n, f] of tests) {
  try { f(); console.log("ok -", n); }
  catch (e) { failed++; console.log("not ok -", n, "\n ", e.message); }
}
console.log(`confirm-cta-above-fold: ${tests.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
