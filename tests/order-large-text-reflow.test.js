#!/usr/bin/env node
// Checkout at 320px with 200% text: progress labels wrap onto rows instead of
// overflowing, and the footer logo wraps. Browser check: npm run e2e.
const fs = require("fs");
const path = require("path");
const css = fs.readFileSync(path.join(__dirname, "..", "frontend/css/style.css"), "utf8");
const mobile = [...css.matchAll(/@media \(max-width: 768px\) \{([\s\S]*?)\n\}/g)].map((m) => m[1]).join("\n");
const tests = [
  ["progress bar wraps", /\.progress-bar \{[^}]*flex-wrap: wrap/],
  ["progress step keeps its label width", /\.progress-step \{[^}]*min-width: max-content/],
  ["footer grid column can shrink", /\.footer-grid \{ grid-template-columns: minmax\(0, 1fr\)/],
  ["footer logo text wraps", /\.footer-brand \.logo-text \{[^}]*white-space: normal/],
  ["long footer links (email) wrap", /\.footer-links a \{ overflow-wrap: anywhere/],
];
let pass = 0;
for (const [name, re] of tests) { const ok = re.test(mobile); console.log((ok ? "ok - " : "not ok - ") + name); if (ok) pass++; }
console.log(pass + "/" + tests.length + " passed");
process.exit(pass === tests.length ? 0 : 1);
