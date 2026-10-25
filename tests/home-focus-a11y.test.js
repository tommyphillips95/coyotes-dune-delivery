#!/usr/bin/env node
/**
 * Home hero search/city kill *:focus-visible with outline:0; ring the group via
 * :focus-within instead. Chat message field needs an accessible name. Nav/chat
 * toggles expose aria-expanded before the first click.
 */
"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const ROOT = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
const coastal = read("frontend/css/coastal.css");
const home = read("frontend/index.html");
const order = read("frontend/order/index.html");
const track = read("frontend/track/index.html");

const tests = [];
const test = (n, f) => tests.push([n, f]);

test("cc-search:focus-within has a visible outline (input keeps outline:0)", () => {
  assert.match(coastal, /\.cc-search input\s*\{[^}]*outline:\s*0/);
  const block = coastal.slice(coastal.indexOf(".cc-search:focus-within"));
  assert.ok(block.length > 0 && block.indexOf(".cc-search:focus-within") === 0, "focus-within rule present");
  const rule = block.slice(0, block.indexOf("}") + 1);
  assert.match(rule, /outline:\s*2\.5px\s+solid/);
  assert.doesNotMatch(rule, /outline:\s*0|outline:\s*none/);
});

test("cc-location:focus-within has a visible outline for the city select", () => {
  assert.match(coastal, /\.cc-location select\s*\{[^}]*outline:\s*0/);
  const i = coastal.indexOf(".cc-location:focus-within");
  assert.ok(i > -1, "focus-within rule present");
  const rule = coastal.slice(i, coastal.indexOf("}", i) + 1);
  assert.match(rule, /outline:\s*2\.5px\s+solid/);
  assert.doesNotMatch(rule, /outline:\s*0|outline:\s*none/);
});

test("chatInput has an accessible name (not placeholder-only)", () => {
  assert.match(home, /id="chatInput"[^>]*aria-label="Message"/);
});

test("navToggle starts with aria-expanded=false on home, order, and track", () => {
  for (const [name, html] of [["home", home], ["order", order], ["track", track]]) {
    assert.match(html, /id="navToggle"[^>]*aria-expanded="false"/, name);
  }
});

test("chatToggle starts with aria-expanded=false", () => {
  assert.match(home, /id="chatToggle"[^>]*aria-expanded="false"/);
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
