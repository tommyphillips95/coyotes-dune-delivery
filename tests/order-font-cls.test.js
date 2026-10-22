#!/usr/bin/env node
/**
 * Order page layout shift (Lighthouse CLS 0.127 on /order/?restaurant=<slug>):
 * order.js un-hid the prefill note + live quote after first paint and pushed
 * #orderForm down ~178px; a font swap could also rewrap the step intro line.
 * Static + vm checks, no browser or network.
 */
"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
const ORDER = read("frontend/order/index.html");
const CC = read("frontend/css/coastal.css");
const CSS = read("frontend/css/style.css");
const JS = read("frontend/js/order.js");

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

function headScript() {
  const head = ORDER.slice(0, ORDER.indexOf("</head>"));
  const m = head.match(/<script>(\(function \(s, c\)[\s\S]*?)<\/script>/);
  assert.ok(m, "no space-reserving script in <head>");
  return m[1];
}
function classesFor(search) {
  const set = new Set();
  const classList = { add: (...a) => a.forEach((x) => set.add(x)) };
  vm.runInNewContext(headScript(), { location: { search }, document: { documentElement: { classList } } });
  return [...set].sort().join(" ");
}

test("head script reserves note+quote space for partner, pickup and category links", () => {
  assert.strictEqual(classesFor("?restaurant=shells-seafood"), "cc-pre-note-2 cc-pre-quote");
  assert.strictEqual(classesFor("?pickup=Port%20Aransas"), "cc-pre-note-1 cc-pre-quote");
  assert.strictEqual(classesFor("?category=food"), "cc-pre-note-1");
  assert.strictEqual(classesFor(""), "");
  assert.strictEqual(classesFor("?service=ride"), "");
});

test("head script runs before the stylesheets (decided before first paint)", () => {
  const i = ORDER.indexOf("cc-pre-note-2"); assert.ok(i >= 0, "no reservation script");
  assert.ok(i < ORDER.indexOf('href="../css/style.css"'));
});

test("CSS keeps the hidden boxes in layout at their rendered heights", () => {
  assert.match(CC, /\.cc-pre-quote #ccLiveQuote\[hidden\] \{[^}]*display: block; visibility: hidden/);
  assert.match(CC, /\.cc-pre-note-1 #ccPrefillNote\[hidden\] \{ min-height: 44px; \}/);
  assert.match(CC, /\.cc-pre-note-2 #ccPrefillNote\[hidden\] \{ min-height: 68px; \}/);
  assert.match(CC, /\.cc-pre-quote #ccLiveQuote\[hidden\] \{ min-height: 76px; \}/);
});

test("order.js releases the reservation after filling the note and quote (and on load)", () => {
  assert.match(JS, /classList\.remove\('cc-pre-note-1', 'cc-pre-note-2', 'cc-pre-quote'\)/);
  const init = JS.slice(JS.indexOf("function init()"));
  assert.ok(init.indexOf("releaseReservedSpace();") > init.indexOf("updateLiveQuote();"));
  assert.match(JS, /addEventListener\('load', releaseReservedSpace\)/);
});

test("metric-matched fallback faces exist for Inter and DM Sans", () => {
  for (const fam of ["Inter Fallback", "DM Sans Fallback"]) {
    const m = CC.match(new RegExp("@font-face \\{ font-family: '" + fam + "';[^}]*\\}"));
    assert.ok(m, "missing " + fam);
    for (const d of ["src: local\\('Arial'\\)", "size-adjust: [\\d.]+%", "ascent-override", "descent-override", "line-gap-override"])
      assert.match(m[0], new RegExp(d), fam + " " + d);
  }
});

test("font stacks put each fallback right after its webfont", () => {
  assert.match(CSS, /--font-body: 'Inter', 'Inter Fallback',/);
  for (const src of [CSS, CC]) assert.match(src, /--font-display: 'DM Sans', 'DM Sans Fallback', 'Inter', 'Inter Fallback',/);
});

let failed = 0;
for (const [name, fn] of tests) {
  try { fn(); console.log("ok - " + name); } catch (e) { failed++; console.log("not ok - " + name + "\n  " + e.message.split("\n")[0]); }
}
process.exit(failed ? 1 : 0);
