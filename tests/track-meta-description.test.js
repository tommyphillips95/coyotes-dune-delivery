#!/usr/bin/env node
// /track/ must ship a meta description so search results and Lighthouse SEO pass.
const fs = require("fs");
const path = require("path");
const html = fs.readFileSync(path.join(__dirname, "..", "frontend/track/index.html"), "utf8");
const m = html.match(/<meta\s+name="description"\s+content="([^"]*)"\s*\/?>/i);
const tests = [
  ["/track/ has a meta description tag", !!m],
  ["description is non-empty", !!(m && m[1].trim().length >= 20)],
  ["description mentions tracking", !!(m && /track/i.test(m[1]))],
];
let pass = 0;
for (const [name, ok] of tests) { console.log((ok ? "ok - " : "not ok - ") + name); if (ok) pass++; }
console.log(pass + "/" + tests.length + " passed");
process.exit(pass === tests.length ? 0 : 1);
