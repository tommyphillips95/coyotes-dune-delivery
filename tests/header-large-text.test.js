#!/usr/bin/env node
// Mobile header at large text sizes: the logo must be able to wrap/shrink and
// the menu button must not be pushed off screen. Browser check: npm run e2e.
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const css = fs.readFileSync(path.join(__dirname, "..", "frontend/css/style.css"), "utf8");
const blocks = [...css.matchAll(/@media \(max-width: 768px\) \{([\s\S]*?)\n\}/g)].map((m) => m[1]).join("\n");
const tests = [
  ["logo text can wrap on mobile", /\.logo-text \{[^}]*white-space: normal/],
  ["logo can shrink (min-width: 0)", /\.logo \{[^}]*min-width: 0/],
  ["menu button never shrinks", /\.nav-toggle \{[^}]*flex-shrink: 0/],
  ["header height grows instead of clipping", /\.nav-container \{[^}]*height: auto/],
  ["navbar logo size is capped", /\.navbar \.logo \{ font-size: min\(1\.2rem, 24px\)/],
];
let pass = 0;
for (const [name, re] of tests) {
  try { assert.match(blocks, re); console.log("ok - " + name); pass++; }
  catch (e) { console.log("not ok - " + name); }
}
console.log(pass + "/" + tests.length + " passed");
process.exit(pass === tests.length ? 0 : 1);
