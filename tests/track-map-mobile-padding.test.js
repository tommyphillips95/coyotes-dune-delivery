#!/usr/bin/env node
/**
 * Track page live map must not inherit style.css .map-container padding:40px
 * (that rule is for the home decorative illustration). At 375px that padding
 * left only ~245px of map width inside a 327px card.
 */
"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const trackHtml = fs.readFileSync(path.join(root, "frontend/track/index.html"), "utf8");
const styleCss = fs.readFileSync(path.join(root, "frontend/css/style.css"), "utf8");

const tests = [];
const test = (n, f) => tests.push([n, f]);

test("style.css still pads the home illustration map-container", () => {
  assert.match(styleCss, /\.map-container\s*\{[^}]*padding:\s*40px/s);
});

test("track page zeros map-container padding so the Leaflet map fills the card", () => {
  const start = trackHtml.indexOf(".map-container {");
  assert.ok(start > -1, "track .map-container rule");
  const block = trackHtml.slice(start, trackHtml.indexOf("}", start) + 1);
  assert.match(block, /padding:\s*0/);
  // Must not re-introduce a non-zero padding later in the same rule.
  assert.doesNotMatch(block, /padding:\s*[1-9]/);
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
