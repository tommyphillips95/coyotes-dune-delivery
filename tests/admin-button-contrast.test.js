#!/usr/bin/env node
// Admin buttons with white text need WCAG AA 4.5:1. Before: .btn-warning
// (the "Set weather hold", Background Check and On Hold buttons) was white on
// #d97706, 3.2:1. Colors are read from admin.css after coastal.css overrides.
"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const ROOT = path.join(__dirname, "..");
const admin = fs.readFileSync(path.join(ROOT, "frontend/admin/admin.css"), "utf8");
const coastal = fs.readFileSync(path.join(ROOT, "frontend/css/coastal.css"), "utf8");
const html = fs.readFileSync(path.join(ROOT, "frontend/admin/index.html"), "utf8");
const js = fs.readFileSync(path.join(ROOT, "frontend/admin/admin.js"), "utf8");

// Later stylesheet wins, matching the <link> order in admin/index.html.
const sheets = [admin, coastal].map((c) => c.replace(/\/\*[\s\S]*?\*\//g, ""));
function varValue(name) {
  let val = null;
  for (const css of sheets) { const re = new RegExp("--" + name + ":\\s*([^;]+);", "g"); let m; while ((m = re.exec(css))) val = m[1].trim(); }
  assert(val, "missing --" + name);
  const ref = /^var\(--([\w-]+)\)$/.exec(val);
  return ref ? varValue(ref[1]) : val;
}
const resolve = (v) => { const ref = /^var\(--([\w-]+)\)$/.exec(v.trim()); return ref ? varValue(ref[1]) : v.trim(); };
function prop(selector, p) {
  let val = null;
  for (const css of sheets) {
    const re = new RegExp("(^|[},\\s])" + selector.replace(/[.:]/g, "\\$&") + "\\s*\\{([^}]*)\\}", "g"); let m;
    while ((m = re.exec(css))) { const d = new RegExp("(?:^|;)\\s*" + p + ":\\s*([^;]+)").exec(m[2]); if (d) val = d[1].replace(/\/\*.*?\*\//g, "").trim(); }
  }
  return val && resolve(val);
}
function lum(hex) {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((x) => (x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

const tests = [];
const test = (n, f) => tests.push([n, f]);

test("admin.css loads before coastal.css (the order this test assumes)", () => {
  assert(html.indexOf('href="admin.css"') < html.indexOf('href="../css/coastal.css"'));
});

test("weather-hold button uses .btn-warning / .btn-success", () => {
  assert(/o\.weather_hold \? 'btn-success' : 'btn-warning'/.test(js));
});

for (const sel of [".btn-warning", ".btn-warning:hover", ".btn-success", ".btn-success:hover", ".btn-danger", ".btn-danger:hover"]) {
  test(`${sel}: white text >= 4.5:1`, () => {
    const bg = prop(sel, "background");
    assert(/^#[0-9a-f]{6}$/i.test(bg || ""), sel + " background " + bg);
    const fg = prop(sel.replace(":hover", ""), "color");
    assert.strictEqual(fg.toLowerCase(), "#fff");
    const r = ratio(bg, "#ffffff");
    assert(r >= 4.5, `${sel}: #fff on ${bg} is ${r.toFixed(2)}:1`);
  });
}

(async () => {
  let failed = 0;
  for (const [n, f] of tests) {
    try { await f(); console.log("ok - " + n); } catch (e) { failed++; console.log("not ok - " + n + "\n  " + e.message); }
  }
  if (failed) { console.error(`admin-button-contrast: ${failed} failed`); process.exit(1); }
  console.log(`admin-button-contrast: ${tests.length} passed`);
})();
