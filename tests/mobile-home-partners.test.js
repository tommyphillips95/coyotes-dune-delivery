#!/usr/bin/env node
/**
 * Mobile sweep of the home page (incl. its partner sections) and the
 * /order/?restaurant=<slug> partner landings: static guards for what a
 * 360-390px headless-Chromium audit caught. No network, no browser.
 */
"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
const HOME = read("frontend/index.html");
const CSS = read("frontend/css/style.css");
const CC = read("frontend/css/coastal.css");
const COASTAL = read("frontend/js/coastal.js");

const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const rule = (src, sel, from = 0) => {
  const i = src.indexOf(sel + " {", from); assert.ok(i >= 0, "missing rule " + sel);
  return src.slice(i, src.indexOf("}", i));
};
const mobile = (src, bp) => src.slice(src.indexOf("@media (max-width: " + bp + ")"));

test("route planner grid tracks can shrink (no page-wide overflow from long <option>s)", () => {
  assert.match(rule(CC, ".cc-planner"), /grid-template-columns: minmax\(0, 1\.3fr\) minmax\(0, 1fr\)/);
  assert.match(rule(mobile(CC, "860px"), ".cc-planner"), /grid-template-columns: minmax\(0, 1fr\)/);
  assert.match(rule(CC, ".cc-row"), /grid-template-columns: minmax\(0, 1fr\) auto minmax\(0, 1fr\)/);
  assert.match(rule(mobile(CC, "560px"), ".cc-row"), /grid-template-columns: minmax\(0, 1fr\)/);
  assert.doesNotMatch(CC, /grid-template-columns: 1fr/, "bare 1fr track has an auto min");
});

test("planner selects/inputs may shrink below their option width", () => {
  assert.match(rule(CC, ".cc-field select, .cc-field input"), /min-width: 0/);
});

test("chat input is >=16px so iOS does not zoom on focus", () => {
  const m = rule(CSS, ".chat-input").match(/font-size: ([\d.]+)rem/);
  assert.ok(m && parseFloat(m[1]) >= 1, "chat-input font-size " + (m && m[1]));
});

test("mobile nav links are >=44px tap targets", () => {
  assert.match(rule(mobile(CSS, "768px"), ".nav-menu a"), /min-height: 44px/);
});

test("closed mobile menu is hidden from focus; open menu is visible", () => {
  const m = mobile(CSS, "768px");
  assert.match(rule(m, ".nav-menu"), /visibility: hidden/);
  assert.match(rule(m, ".nav-menu.active"), /visibility: visible/);
});

test("home page opts into safe-area insets (viewport-fit=cover)", () => {
  assert.match(HOME, /name="viewport"[^>]*viewport-fit=cover/);
});

test("every home partner link points at a known partner slug", () => {
  const known = new Set([...COASTAL.matchAll(/slug: "([a-z0-9-]+)"/g)].map((m) => m[1]));
  const linked = [...HOME.matchAll(/restaurant=([a-z0-9-]+)/g)].map((m) => m[1]);
  assert.ok(linked.length >= 6, "partner links found: " + linked.length);
  for (const s of linked) assert.ok(known.has(s), "unknown partner slug " + s);
});

test("in-page #anchors on the home page resolve", () => {
  const ids = new Set([...HOME.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
  for (const [, a] of HOME.matchAll(/href="#([^"]+)"/g)) assert.ok(ids.has(a), "dangling #" + a);
});

let failed = 0;
for (const [name, fn] of tests) {
  try { fn(); console.log("ok - " + name); } catch (e) { failed++; console.log("not ok - " + name + "\n  " + e.message); }
}
process.exit(failed ? 1 : 0);
