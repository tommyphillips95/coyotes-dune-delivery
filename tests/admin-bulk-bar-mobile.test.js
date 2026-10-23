#!/usr/bin/env node
// Admin bulk-action bar at phone width. It was a single non-wrapping flex row
// (count + 4 buttons, ~575px), so at 375px Approve/Reject sat off-screen and
// the page scrolled sideways. It now wraps, stays within its container, and
// under 768px goes full width with the buttons two per row.
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const ROOT = path.join(__dirname, "..");
const css = fs.readFileSync(path.join(ROOT, "frontend/admin/admin.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const html = fs.readFileSync(path.join(ROOT, "frontend/admin/index.html"), "utf8");

/** Declarations of `selector { ... }` at top level or inside the given @media block text. */
function rule(text, selector) {
  const esc = selector.replace(/[.#*+?^${}()|[\]\\]/g, "\\$&");
  const m = new RegExp("(?:^|[}\\s])" + esc + "\\s*\\{([^}]*)\\}", "m").exec(text);
  return m ? m[1] : null;
}
function mediaBlocks(maxWidth) {
  const out = []; const re = new RegExp("@media\\s*\\(max-width:\\s*" + maxWidth + "px\\)\\s*\\{", "g"); let m;
  while ((m = re.exec(css))) { let depth = 1, i = re.lastIndex; while (depth && i < css.length) { if (css[i] === "{") depth++; else if (css[i] === "}") depth--; i++; } out.push(css.slice(re.lastIndex, i - 1)); }
  return out.join("\n");
}
const topLevel = css.replace(/@media[^{]*\{(?:[^{}]*\{[^}]*\})*[^{}]*\}/g, "");

const tests = [];
const t = (n, f) => tests.push([n, f]);

t("bulk bar markup still has Approve and Reject", () => {
  assert.ok(/id="bulk-actions"/.test(html) && /data-bulk="approved"/.test(html) && /data-bulk="rejected"/.test(html));
});
t(".bulk-actions wraps and never exceeds its container", () => {
  const r = rule(topLevel, ".bulk-actions");
  assert.ok(r, ".bulk-actions rule");
  assert.ok(/flex-wrap:\s*wrap/.test(r), "flex-wrap: wrap");
  assert.ok(/max-width:\s*100%/.test(r), "max-width: 100%");
  assert.ok(/box-sizing:\s*border-box/.test(r), "padding inside the width");
});
t("phone layout: full-width bar, count on its own line, buttons two per row and shrinkable", () => {
  const m = mediaBlocks(768);
  assert.ok(/width:\s*100%/.test(rule(m, ".bulk-actions") || ""), "bar full width");
  assert.ok(/flex-basis:\s*100%/.test(rule(m, ".bulk-actions #bulk-count") || ""), "count on own line");
  const b = rule(m, ".bulk-actions .btn") || "";
  assert.ok(/flex:\s*1 1 calc\(50% - 8px\)/.test(b), "two per row");
  assert.ok(/min-width:\s*0/.test(b) && /white-space:\s*normal/.test(b), "labels may wrap instead of overflowing");
});

let failed = 0;
for (const [n, f] of tests) { try { f(); console.log("ok -", n); } catch (e) { failed++; console.error("not ok -", n, "\n ", e.message); } }
console.log(failed ? `${failed} failed` : `admin-bulk-bar-mobile: ${tests.length} passed`);
process.exit(failed ? 1 : 0);
