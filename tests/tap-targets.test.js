#!/usr/bin/env node
// Footer/nav text links and consent checkboxes get >=44px tap targets on
// phones, by CSS only: link text, URLs, legal text and contact info unchanged.
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const root = path.join(__dirname, "..");
const css = fs.readFileSync(path.join(root, "frontend/css/style.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const order = fs.readFileSync(path.join(root, "frontend/order/index.html"), "utf8");
const tests = [];
const test = (n, f) => tests.push([n, f]);
// Last rule for a selector wins; collect every block for it.
const rules = (sel) => [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)].filter((m) => m[1].split(",").map((s) => s.trim()).includes(sel)).map((m) => m[2]).join(";");
const px = (decls, prop) => { const m = [...decls.matchAll(new RegExp("(?:^|[;\\s])" + prop + "\\s*:\\s*(\\d+)px", "g"))].pop(); return m ? +m[1] : 0; };

test("footer links are at least 44x44", () => {
  const r = rules(".footer-links a");
  assert.ok(/display:\s*inline-flex/.test(r), "inline links ignore min-height");
  assert.ok(px(r, "min-height") >= 44);
  assert.ok(px(r, "min-width") >= 44);
});
test("nav/footer logo link is at least 44px tall", () => {
  assert.ok(px(rules(".logo"), "min-height") >= 44);
});
test("consent checkbox: label gives a 44x44 hit area", () => {
  assert.ok(/position:\s*relative/.test(rules(".checkbox-group")));
  const r = rules(".checkbox-group > label::before");
  assert.ok(/content:/.test(r) && /position:\s*absolute/.test(r));
  assert.ok(px(r, "width") >= 44 && px(r, "height") >= 44);
  assert.ok(/<input type="checkbox" id="termsAgree"[^>]*>\s*<label for="termsAgree">/.test(order), "label must be tied to the checkbox");
});
test("footer text, links and contact info unchanged", () => {
  for (const s of ['<a href="mailto:support@coyotesdune.com">support@coyotesdune.com</a>', '<a href="tel:+13615551234">(361) 555-1234</a>',
    '<a href="#">Privacy Policy</a>', '<a href="#">Terms of Service</a>', '<a href="/apply/">Become a Driver</a>', '<a href="/driver/">Driver Portal</a>']) assert.ok(order.includes(s), s);
});

(async () => {
  let failed = 0;
  for (const [n, f] of tests) {
    try { await f(); console.log("ok -", n); } catch (e) { failed++; console.error("not ok -", n, "\n ", e.message); }
  }
  process.exit(failed ? 1 : 0);
})();
