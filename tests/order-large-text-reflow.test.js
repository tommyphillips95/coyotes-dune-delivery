#!/usr/bin/env node
// Checkout at 320px with 200% text: progress labels wrap onto rows instead of
// overflowing, footer logo wraps, and confirm/review titles + summary reflow.
// Browser check: npm run e2e.
const fs = require("fs");
const path = require("path");
const css = fs.readFileSync(path.join(__dirname, "..", "frontend/css/style.css"), "utf8");
const orderHtml = fs.readFileSync(path.join(__dirname, "..", "frontend/order/index.html"), "utf8");
const mobile = [...css.matchAll(/@media \(max-width: 768px\) \{([\s\S]*?)\n\}/g)].map((m) => m[1]).join("\n");
const tests = [
  ["progress bar wraps", /\.progress-bar \{[^}]*flex-wrap: wrap/, mobile],
  ["progress step keeps its label width", /\.progress-step \{[^}]*min-width: max-content/, mobile],
  ["footer grid column can shrink", /\.footer-grid \{ grid-template-columns: minmax\(0, 1fr\)/, mobile],
  ["footer logo text wraps", /\.footer-brand \.logo-text \{[^}]*white-space: normal/, mobile],
  ["long footer links (email) wrap", /\.footer-links a \{ overflow-wrap: anywhere/, mobile],
  ["confirm h2 wraps at large text (order page)", /\.order-success h2 \{[^}]*overflow-wrap:\s*anywhere/s, orderHtml],
  ["estimate rows wrap at large text", /\.estimate-row \{[^}]*flex-wrap:\s*wrap/s, orderHtml],
  ["summary table cells wrap on mobile", /\.summary-table th, \.summary-table td \{[^}]*overflow-wrap:\s*anywhere/s, orderHtml],
  ["form-success h2 wraps (shared CSS)", /\.form-success h2 \{[^}]*overflow-wrap:\s*anywhere/s, css],
];
let pass = 0;
for (const [name, re, src] of tests) {
  const ok = re.test(src);
  console.log((ok ? "ok - " : "not ok - ") + name);
  if (ok) pass++;
}
console.log(pass + "/" + tests.length + " passed");
process.exit(pass === tests.length ? 0 : 1);
