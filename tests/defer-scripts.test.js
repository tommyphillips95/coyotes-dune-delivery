#!/usr/bin/env node
// Checkout and tracking pages: external scripts must not block rendering
// (Lighthouse "render-blocking resources"). defer keeps execution order and
// still runs before DOMContentLoaded, so init code is unaffected.
const fs = require("fs");
const path = require("path");
const tests = [];
for (const page of ["frontend/order/index.html", "frontend/track/index.html"]) {
  const html = fs.readFileSync(path.join(__dirname, "..", page), "utf8");
  const tags = html.match(/<script\b[^>]*\bsrc=[^>]*>/g) || [];
  tests.push([page + " has external scripts", tags.length > 0]);
  for (const t of tags) tests.push([page + " " + t.match(/src="([^"]+)"/)[1] + " is defer/async", /\b(defer|async)\b/.test(t)]);
}
let pass = 0;
for (const [name, ok] of tests) { console.log((ok ? "ok - " : "not ok - ") + name); if (ok) pass++; }
console.log(pass + "/" + tests.length + " passed");
process.exit(pass === tests.length ? 0 : 1);
