#!/usr/bin/env node
/** Order Confirmed: Back to Home is outline; Track stays solid primary. */
"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const css = fs.readFileSync(path.join(__dirname, "..", "frontend/css/coastal.css"), "utf8");
const html = fs.readFileSync(path.join(__dirname, "..", "frontend/order/index.html"), "utf8");

const tests = [];
const test = (n, f) => tests.push([n, f]);

test("success markup: Track primary, Back secondary, Book Another text link", () => {
  assert.match(html, /class="btn btn-primary cc-track-link" id="ccTrackLink"/);
  assert.match(html, /class="btn btn-secondary">Back to Home</);
  assert.match(html, /class="cc-book-another">Book Another</);
});

test("coastal: only .order-success a.btn-secondary becomes outline", () => {
  const start = css.indexOf(".order-success a.btn-secondary");
  assert.ok(start > -1);
  const block = css.slice(start, css.indexOf("}", start) + 1);
  assert.match(block, /background:\s*transparent/);
  assert.match(block, /border:\s*2px solid/);
  // Global .btn-secondary must not be restyled to transparent in coastal.css.
  const global = css.match(/(?:^|\n)\.btn-secondary\s*\{[^}]+\}/);
  assert.ok(!global || !/background:\s*transparent/.test(global[0]), "must not restyle global .btn-secondary");
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
