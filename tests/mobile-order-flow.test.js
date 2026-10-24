// Static checks for the mobile order-flow fixes (behaviour covered by the
// Playwright mobile smoke run locally; CI has no browser).
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const fe = path.join(__dirname, "..", "frontend");
const read = (p) => fs.readFileSync(path.join(fe, p), "utf8");
const orderJs = read("js/order.js"), style = read("css/style.css"), coastal = read("css/coastal.css"), orderHtml = read("order/index.html");
let failed = 0;
function test(name, fn) { try { fn(); console.log("ok - " + name); } catch (e) { failed++; console.error("not ok - " + name + "\n  " + e.message); } }
const px = (v, u) => (u === "rem" ? parseFloat(v) * 16 : parseFloat(v));

test("home planner selects/inputs are >=16px (no iOS focus zoom)", () => {
  const m = coastal.match(/\.cc-field select, \.cc-field input \{([^}]*)\}/);
  assert(m, "rule missing");
  const f = m[1].match(/font-size:\s*([\d.]+)(rem|px)/);
  assert(f && px(f[1], f[2]) >= 16, "font-size " + (f && f[0]));
});

test("step change moves focus to the new step heading", () => {
  const g = orderJs.slice(orderJs.indexOf("function goToStep"), orderJs.indexOf("function showError"));
  assert(/\.form-step\[data-step="\$\{step\}"\] h2/.test(g), "queries step heading");
  assert(/heading\.focus\(/.test(g), "focuses heading");
  assert(/tabindex', '-1'/.test(g), "heading made focusable");
});

test("step 1 invalid date/time marks the field so it gets focus", () => {
  const v = orderJs.slice(orderJs.indexOf("function validateStep"), orderJs.indexOf("if (step === 2)"));
  assert(/classList\.toggle\('error'/.test(v) && /aria-invalid/.test(v), "marks date/time field");
  assert(/id="dateTimeError" role="alert"/.test(orderHtml), "error announced");
});

test("mobile Next/Back and menu toggle meet 44px tap targets", () => {
  const i = style.lastIndexOf(".form-nav-right .btn { flex: 1; }");
  const block = style.slice(i, i + 1200);
  const b = block.match(/\.form-nav \.btn \{ min-height: (\d+)px/);
  assert(b && +b[1] >= 44, "form-nav btn min-height");
  const t = style.match(/\.nav-toggle \{ width: (\d+)px; height: (\d+)px/);
  assert(t && +t[1] >= 44 && +t[2] >= 44, "nav-toggle size");
});


test("mobile form-nav sticks to the viewport bottom so Next/Place Order stay reachable", () => {
  const i = style.indexOf(".form-step.active .form-nav");
  assert(i > -1, "sticky form-nav rule missing");
  const block = style.slice(i, i + 350);
  assert(/position:\s*sticky/.test(block), "position sticky");
  assert(/bottom:\s*0/.test(block), "bottom 0");
  assert(/safe-area-inset-bottom/.test(block), "home-indicator padding");
  assert(i > style.indexOf("@media (max-width: 768px)"), "inside phone media query");
});

test("payment step Pay/Pay Later stick on phones (keyboard / short viewport)", () => {
  const sp = read("js/stripe-payment.js");
  const i = sp.indexOf("@media (max-width: 768px)");
  assert(i > -1, "payment mobile media query");
  const block = sp.slice(i, i + 500);
  assert(/\.payment-actions\s*\{[\s\S]*?position:\s*sticky/.test(block), "payment-actions sticky");
  assert(/bottom:\s*0/.test(block), "bottom 0");
});


test("form-container allows sticky CTAs (overflow visible, not hidden)", () => {
  const i = style.indexOf(".form-container {");
  assert(i > -1);
  const block = style.slice(i, style.indexOf("\n}", i) + 3);
  assert(/^[ \t]*overflow:\s*visible\s*;/m.test(block), "overflow visible for sticky");
});

if (failed) { console.error(failed + " failed"); process.exit(1); }
console.log("mobile-order-flow tests passed");
