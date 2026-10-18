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
  const block = style.slice(i, i + 400);
  const b = block.match(/\.form-nav \.btn \{ min-height: (\d+)px/);
  assert(b && +b[1] >= 44, "form-nav btn min-height");
  const t = block.match(/\.nav-toggle \{ width: (\d+)px; height: (\d+)px/);
  assert(t && +t[1] >= 44 && +t[2] >= 44, "nav-toggle size");
});

if (failed) { console.error(failed + " failed"); process.exit(1); }
console.log("mobile-order-flow tests passed");
