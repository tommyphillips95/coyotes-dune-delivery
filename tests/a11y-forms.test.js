#!/usr/bin/env node
/**
 * Accessible labels + visible, linked error messages on the order form and the
 * driver application form. Static checks on the HTML/CSS plus the real
 * validation functions from order.js / apply.js run against a tiny fake DOM.
 * No network, no browser.
 */
"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
const ORDER = read("frontend/order/index.html");
const APPLY = read("frontend/apply/index.html");
const CSS = read("frontend/css/style.css");
const ORDER_JS = read("frontend/js/order.js");
const APPLY_JS = read("frontend/js/apply.js");

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

const attrs = (tag) => { const a = {}; tag.replace(/([\w-]+)(?:="([^"]*)")?/g, (_, k, v) => { a[k] = v === undefined ? "" : v; }); return a; };
function controls(html) {
  const out = [];
  const re = /<(input|select|textarea)\b[^>]*>/g; let m;
  while ((m = re.exec(html))) {
    const a = attrs(m[0].slice(m[1].length + 1));
    if (/^(hidden|submit|button)$/.test(a.type || "")) continue;
    out.push({ tag: m[1], a, at: m.index });
  }
  return out;
}
const wrappedBy = (html, at, open, close) => html.lastIndexOf(open, at) > html.lastIndexOf(close, at);
function hasLabel(html, c) {
  if (c.a["aria-label"] || c.a["aria-labelledby"]) return true;
  if (c.a.id && new RegExp(`<label[^>]*\\bfor="${c.a.id}"`).test(html)) return true;
  return wrappedBy(html, c.at, "<label", "</label>");
}

for (const [page, html] of [["order", ORDER], ["apply", APPLY]]) {
  test(`${page}: every input/select/textarea has a programmatic label`, () => {
    const bad = controls(html).filter((c) => !hasLabel(html, c)).map((c) => c.a.id || c.a.name);
    assert.deepStrictEqual(bad, []);
  });
  test(`${page}: every radio group sits in a fieldset with a legend`, () => {
    const bad = controls(html).filter((c) => c.a.type === "radio").filter((c) => {
      if (!wrappedBy(html, c.at, "<fieldset", "</fieldset>")) return true;
      const fs = html.lastIndexOf("<fieldset", c.at);
      return html.slice(fs, c.at).indexOf("<legend") < 0;
    }).map((c) => c.a.name);
    assert.deepStrictEqual([...new Set(bad)], []);
  });
  test(`${page}: required fields are marked visibly (*) next to their label/legend`, () => {
    const bad = controls(html).filter((c) => "required" in c.a && c.a.type !== "radio").filter((c) => {
      const lab = html.match(new RegExp(`<label[^>]*\\bfor="${c.a.id}"[^>]*>([\\s\\S]*?)</label>`));
      if (lab && /class="required"/.test(lab[1])) return false;
      const fs = html.lastIndexOf("<legend", c.at);
      return !(fs >= 0 && wrappedBy(html, c.at, "<fieldset", "</fieldset>") && /class="required"/.test(html.slice(fs, html.indexOf("</legend>", fs))));
    }).map((c) => c.a.id);
    assert.deepStrictEqual(bad, []);
  });
}

test("apply: every required field has an inline error element in its group", () => {
  const bad = controls(APPLY).filter((c) => "required" in c.a).filter((c) => {
    const start = Math.max(APPLY.lastIndexOf('class="form-group', c.at), APPLY.lastIndexOf('class="checkbox-group', c.at));
    const next = APPLY.slice(c.at + 1).search(/class="(form-group|checkbox-group|form-nav)/);
    return !/class="error-message"/.test(APPLY.slice(start, c.at + 1 + next));
  }).map((c) => c.a.id);
  assert.deepStrictEqual(bad, []);
});

test("server-error summaries are live regions that can take focus", () => {
  assert.match(APPLY, /id="submitError" tabindex="-1" role="alert" aria-live="assertive"/);
  assert.match(ORDER, /id="orderSubmitError" tabindex="-1" role="alert" aria-live="assertive"/);
});

// WCAG contrast of the error text on white and on the warm-white checkbox panels.
const lum = (hex) => { const v = hex.match(/\w\w/g).map((h) => parseInt(h, 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)); return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2]; };
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
test("error text colours are at least 4.5:1 on white and warm-white", () => {
  const col = (src, sel) => { const i = src.indexOf(sel); assert.ok(i >= 0, sel); return src.slice(i, src.indexOf("}", i)).match(/color:\s*(#[0-9a-fA-F]{6})/)[1]; };
  for (const c of [col(CSS, ".form-group .error-message {"), col(CSS, ".checkbox-group .error-message {"), col(ORDER, ".order-inline-error {")]) {
    for (const bg of ["#FFFFFF", "#FAF8F5"]) assert.ok(ratio(c, bg) >= 4.5, `${c} on ${bg} = ${ratio(c, bg).toFixed(2)}`);
  }
});

// ── Tiny fake DOM: enough for the validation helpers ──────────────────────
function makeDom() {
  const doc = { activeElement: null, byId: {} };
  class El {
    constructor(tag, opts = {}) {
      Object.assign(this, { tagName: tag.toUpperCase(), children: [], parent: null, attrs: {}, value: "", checked: false, type: "", required: false, hidden: false, textContent: "" }, opts);
      const set = new Set(opts.cls || []); this._cls = set;
      this.classList = { add: (c) => set.add(c), remove: (c) => set.delete(c), contains: (c) => set.has(c), toggle: (c, on) => { if (on === undefined) on = !set.has(c); on ? set.add(c) : set.delete(c); return on; } };
      if (opts.id) { this.id = opts.id; doc.byId[opts.id] = this; } else this.id = "";
    }
    add(...kids) { kids.forEach((k) => { k.parent = this; this.children.push(k); }); return this; }
    matches(sel) { return sel.startsWith(".") ? this._cls.has(sel.slice(1)) : this.tagName === sel.toUpperCase(); }
    closest(sel) { let e = this; while (e) { if (e.matches(sel)) return e; e = e.parent; } return null; }
    querySelector(sel) { for (const k of this.children) { if (k.matches(sel)) return k; const f = k.querySelector(sel); if (f) return f; } return null; }
    getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
    setAttribute(k, v) { this.attrs[k] = String(v); if (k === "id") { this.id = v; doc.byId[v] = this; } }
    removeAttribute(k) { delete this.attrs[k]; }
    hasAttribute(k) { return k in this.attrs; }
    focus() { doc.activeElement = this; }
    scrollIntoView() {}
  }
  doc.getElementById = (id) => doc.byId[id] || null;
  return { doc, El };
}
// Pull named top-level functions out of the IIFE source.
function fn(src, name) {
  const i = src.indexOf(`function ${name}(`);
  if (i < 0) return "";
  let d = 0, j = src.indexOf("{", i);
  for (; j < src.length; j++) { if (src[j] === "{") d++; else if (src[j] === "}" && --d === 0) break; }
  return src.slice(i, j + 1) + "\n";
}
const linked = (input, err) => (input.getAttribute("aria-describedby") || "").split(/\s+/).includes(err.id);

function applySandbox() {
  const { doc, El } = makeDom();
  const field = (id, opts = {}) => {
    const input = new El("input", { id, name: id, required: true, attrs: opts.attrs || {} });
    const err = new El("span", { cls: ["error-message"] });
    const g = new El("div", { cls: ["form-group"] }).add(input, err);
    return { input, err, g };
  };
  const first = field("firstName"), last = field("lastName");
  const vc = field("vehicleClass", { attrs: { "aria-describedby": "vehicleClassHelp" } });
  const insuranceInput = new El("input", { id: "insuranceCard", type: "file", required: true });
  const insuranceError = new El("span", { id: "insuranceError", cls: ["error-message"] });
  const steps = { 1: [first.input, last.input], 2: [vc.input], 3: [] };
  const ctx = { document: doc, validators: {}, uploadedFiles: {}, insuranceInput, insuranceError, INSURANCE_REQUIRED_MSG: "Please upload your insurance card.", getStepInputEls: (n) => steps[n] || [] };
  vm.createContext(ctx);
  vm.runInContext(["linkError", "focusField", "validateField", "validateStep"].map((n) => fn(APPLY_JS, n)).join(""), ctx);
  return { ctx, doc, first, last, vc, insuranceInput, insuranceError };
}

test("apply: blank required field shows a linked error and aria-invalid", () => {
  const { ctx, first } = applySandbox();
  assert.strictEqual(ctx.validateField(first.input), false);
  assert.ok(first.err.classList.contains("visible"), "error shown");
  assert.ok(first.err.id, "error has an id");
  assert.ok(linked(first.input, first.err), "aria-describedby points at the error");
  assert.strictEqual(first.input.getAttribute("aria-invalid"), "true");
  first.input.value = "Ana";
  assert.strictEqual(ctx.validateField(first.input), true);
  assert.ok(!first.err.classList.contains("visible"));
  assert.ok(!linked(first.input, first.err), "unlinked once fixed");
  assert.strictEqual(first.input.getAttribute("aria-invalid"), "false");
});

test("apply: linking an error keeps existing hint ids (vehicleClassHelp)", () => {
  const { ctx, vc } = applySandbox();
  ctx.validateField(vc.input);
  assert.deepStrictEqual(vc.input.getAttribute("aria-describedby").split(" "), ["vehicleClassHelp", vc.err.id]);
  vc.input.value = "car"; ctx.validateField(vc.input);
  assert.strictEqual(vc.input.getAttribute("aria-describedby"), "vehicleClassHelp");
});

test("apply: Next on an invalid step focuses the first invalid field", () => {
  const { ctx, doc, first, last } = applySandbox();
  first.input.value = "Ana";
  assert.strictEqual(ctx.validateStep(1), false);
  assert.strictEqual(doc.activeElement, last.input);
});

test("apply: missing insurance card links insuranceError and focuses the file input", () => {
  const { ctx, doc, insuranceInput, insuranceError } = applySandbox();
  assert.strictEqual(ctx.validateStep(3), false);
  assert.ok(linked(insuranceInput, insuranceError));
  assert.strictEqual(insuranceInput.getAttribute("aria-invalid"), "true");
  assert.strictEqual(doc.activeElement, insuranceInput);
});

function orderSandbox() {
  const { doc, El } = makeDom();
  const input = new El("input", { id: "pickupCity", required: true });
  const err = new El("span", { cls: ["error-message"] });
  new El("div", { cls: ["form-group"] }).add(input, err);
  const terms = new El("input", { id: "termsAgree", type: "checkbox" });
  const termsError = new El("p", { id: "termsError", hidden: true });
  const group = new El("fieldset", { id: "pickupZipAreaGroup", attrs: { "aria-describedby": "pickupZipAreaHelp" } });
  const zipErr = new El("p", { id: "pickupZipAreaError", hidden: true });
  doc.querySelectorAll = () => [];
  const ctx = { document: doc };
  vm.createContext(ctx);
  vm.runInContext(["linkError", "showError", "setTermsError", "setZipAreaError"].map((n) => fn(ORDER_JS, n)).join(""), ctx);
  return { ctx, input, err, terms, termsError, group, zipErr };
}

test("order: blank required field shows a linked error and aria-invalid", () => {
  const { ctx, input, err } = orderSandbox();
  ctx.showError(input, true);
  assert.ok(err.classList.contains("visible"));
  assert.ok(linked(input, err), "aria-describedby points at the error");
  assert.strictEqual(input.getAttribute("aria-invalid"), "true");
  ctx.showError(input, false);
  assert.ok(!linked(input, err));
});

test("order: terms and island/mainland errors are linked only while shown", () => {
  const { ctx, terms, termsError, group, zipErr } = orderSandbox();
  assert.ok(!/termsError/.test((ORDER.match(/<input[^>]*id="termsAgree"[^>]*>/) || [""])[0]), "not linked in static HTML");
  ctx.setTermsError(true);
  assert.ok(!termsError.hidden && linked(terms, termsError));
  ctx.setTermsError(false);
  assert.ok(!linked(terms, termsError));
  ctx.setZipAreaError("pickup", true);
  assert.deepStrictEqual(group.getAttribute("aria-describedby").split(" "), ["pickupZipAreaHelp", "pickupZipAreaError"]);
  ctx.setZipAreaError("pickup", false);
  assert.strictEqual(group.getAttribute("aria-describedby"), "pickupZipAreaHelp");
});

test("order: step date/time errors are linked to the field to fix", () => {
  assert.match(ORDER_JS, /linkError\(el, dateTimeError, el === bad\)/);
});

test("server errors move focus to the summary box", () => {
  for (const [src, name] of [[ORDER_JS, "showSubmitError"], [APPLY_JS, "showSubmitError"]]) assert.match(fn(src, name), /\.focus\(/, name);
});

let failed = 0;
for (const [name, f] of tests) {
  try { f(); console.log("ok - " + name); } catch (e) { failed++; console.log("not ok - " + name + "\n  " + (e && e.message)); }
}
console.log(`\n${tests.length - failed}/${tests.length} passed`);
process.exit(failed ? 1 : 0);
