#!/usr/bin/env node
// WCAG AA (4.5:1) for the brand coral/teal where it carries text, read from
// the CSS variables in coastal.css. Lighthouse flagged 32 contrast failures
// on the home page before this (white on #FF6B4A was 2.81:1).
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const ROOT = path.join(__dirname, "..");
const css = fs.readFileSync(path.join(ROOT, "frontend/css/coastal.css"), "utf8");
const style = fs.readFileSync(path.join(ROOT, "frontend/css/style.css"), "utf8");
const v = (name) => { const m = new RegExp("--" + name + ":\\s*(#[0-9A-Fa-f]{6})").exec(css); assert(m, "missing --" + name); return m[1]; };
function lum(hex) {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((x) => (x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
const WHITE = "#FFFFFF";
const tests = [];
const test = (n, f) => tests.push([n, f]);
const atLeast = (fg, bg, min, what) => { const r = ratio(fg, bg); assert(r >= min, `${what}: ${fg} on ${bg} is ${r.toFixed(2)}:1 (< ${min})`); };

test("white text on coral fills (buttons, active step, track button) >= 4.5", () => {
  atLeast(v("cc-coral-strong"), WHITE, 4.5, "coral-strong button");
  atLeast(v("cc-coral-dark"), WHITE, 4.5, "coral-dark hover");
  assert(lum(v("cc-coral-dark")) < lum(v("cc-coral-strong")), "hover is darker than the button");
  assert(/\.btn-primary, \.btn\.btn-primary \{\s*background: var\(--cc-coral-strong\)/.test(css), ".btn-primary uses coral-strong");
  assert(/\.btn-primary:hover, \.btn\.btn-primary:hover \{\s*background: var\(--cc-coral-dark\)/.test(css), "hover uses coral-dark");
  assert(/--primary: var\(--cc-coral-strong\)/.test(css), "--primary (admin/driver buttons) uses coral-strong");
  assert(/\.lookup-form button, #lookupBtn \{ background: var\(--cc-coral-strong\)/.test(css));
  assert(/\.progress-step\.active \.step-number[^{]*\{ background: var\(--cc-coral-strong\)/.test(css));
});

test("coral text on cream/white/coral-soft >= 4.5", () => {
  for (const bg of [WHITE, v("cc-cream"), v("cc-cream-2"), v("cc-coral-soft"), "#FAF0E3", "#FAF6F2"]) atLeast(v("cc-coral-dark"), bg, 4.5, "coral text");
  assert(/\.section-label, \.partner-location[^{]*\{ color: var\(--cc-coral-dark\); \}/.test(css), "section labels / partner towns use coral-dark");
});

test("teal text on cream/cream-2/seafoam-soft >= 4.5; white on teal fills >= 4.5", () => {
  for (const bg of [WHITE, v("cc-cream"), v("cc-cream-2"), v("cc-seafoam-soft")]) atLeast(v("cc-seafoam-dark"), bg, 4.5, "teal text");
  atLeast(v("cc-seafoam-dark"), WHITE, 4.5, "white on seafoam-dark");
  assert(/\.btn-seafoam:hover \{ background: var\(--cc-seafoam-dark\)/.test(css), "seafoam hover with white text uses the dark shade");
  assert(/\.progress-step\.completed \.step-number[^{]*\{ background: var\(--cc-seafoam-dark\)/.test(css));
});

test("muted text and partner tags >= 4.5", () => {
  for (const bg of [WHITE, v("cc-cream"), v("cc-cream-2")]) atLeast(v("cc-muted"), bg, 4.5, "muted");
  const tag = (cls) => new RegExp("\\.partner-" + cls + " \\.partner-category \\{\\s*color: (#[0-9A-Fa-f]{6})").exec(style)[1];
  atLeast(tag("restaurant"), WHITE, 4.5, "restaurant tag"); atLeast(tag("grocery"), WHITE, 4.5, "grocery tag");
});

test("brand coral stays the accent on dark navy (hero <em>, logo) where it already passes", () => {
  assert.strictEqual(v("cc-coral").toUpperCase(), "#FF6B4A");
  atLeast(v("cc-coral"), v("cc-ink"), 4.5, "coral on ink");
  assert(/\.cc-hero h1 em \{[^}]*color: var\(--cc-coral\)/.test(css));
});

let failed = 0;
for (const [n, f] of tests) { try { f(); console.log("ok -", n); } catch (e) { failed++; console.error("not ok -", n, "\n ", e.message); } }
console.log(failed ? `${failed} failed` : `brand-contrast: ${tests.length} passed`);
process.exit(failed ? 1 : 0);
