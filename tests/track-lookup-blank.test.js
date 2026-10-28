#!/usr/bin/env node
/**
 * Track page: submitting the lookup form with a blank order number and/or
 * phone must tell the customer to enter both, and must not call the API.
 * Runs the real track.js in a vm (same harness as track-lookup-errors).
 */
"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(ROOT, "frontend/track/index.html"), "utf8");
const src = fs.readFileSync(path.join(ROOT, "frontend/track/track.js"), "utf8");
const coastalSrc = fs.readFileSync(path.join(ROOT, "frontend/js/coastal.js"), "utf8");

const BOTH = /Enter both your order number and the phone number used for the order/;

function el(id) {
  const classes = new Set();
  const attrs = Object.create(null);
  return {
    id, textContent: "", value: "", hidden: false, disabled: false, listeners: {},
    classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c), contains: (c) => classes.has(c), toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)) },
    addEventListener(t, f) { this.listeners[t] = f; }, focus() { this._focused = true; },
    setAttribute(k, v) { attrs[k] = String(v); },
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(attrs, k) ? attrs[k] : null; },
    removeAttribute(k) { delete attrs[k]; },
    hasAttribute(k) { return Object.prototype.hasOwnProperty.call(attrs, k); },
  };
}

function load() {
  const els = {};
  [...html.matchAll(/\bid="([^"]+)"/g)].forEach((m) => { els[m[1]] = el(m[1]); });
  const calls = [];
  const fetch = async (url) => { calls.push(url); throw new Error("fetch must not run on blank submit"); };
  const store = {};
  const window = {
    location: { search: "" }, addEventListener() {}, matchMedia: () => ({ matches: false }),
    localStorage: { getItem: (k) => store[k] || null, setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } },
  };
  const ctx = {
    window, document: { getElementById: (id) => els[id] || null, body: el("body") }, fetch,
    console: { error() {}, log() {} },
    L: { map: () => ({ setView() { return this; }, invalidateSize() {}, fitBounds() {} }), tileLayer: () => ({ addTo() {} }), marker: () => ({ addTo() { return this; }, bindPopup() { return this; } }), latLngBounds: () => ({ pad() { return {}; } }), Browser: { mobile: false } },
    localStorage: window.localStorage, sessionStorage: window.localStorage,
    setInterval: () => 1, clearInterval() {}, setTimeout: () => 0, clearTimeout() {},
    URLSearchParams, alert() {}, ResizeObserver: undefined,
  };
  window.window = window; window.document = ctx.document;
  vm.createContext(ctx);
  vm.runInContext(coastalSrc, ctx);
  ctx.CoyoteCoastal = window.CoyoteCoastal;
  vm.runInContext(src, ctx);
  const submit = async (orderNumber, phone) => {
    els.lookupOrderNum.value = orderNumber;
    els.lookupPhone.value = phone;
    // Mark a user-started lookup so focus restoration runs.
    ctx.document.activeElement = els.lookupBtn;
    await els.lookupForm.listeners.submit({ preventDefault() {} });
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
  };
  return { els, submit, calls, msg: () => els.lookupMessage.textContent };
}

const tests = [];
const test = (n, f) => tests.push([n, f]);

test("both blank: message, no fetch, Track Order re-enabled", async () => {
  const t = load();
  await t.submit("", "");
  assert.match(t.msg(), BOTH);
  assert.deepStrictEqual(t.calls, []);
  assert.strictEqual(t.els.lookupBtn.disabled, false);
  assert.strictEqual(t.els.lookupBtn.textContent, "Track Order");
  assert.ok(t.els.lookupOrderNum._focused, "focus order number when both blank");
  assert.strictEqual(t.els.lookupOrderNum.getAttribute("aria-invalid"), "true");
  assert.strictEqual(t.els.lookupPhone.getAttribute("aria-invalid"), "true");
  assert.match(t.els.lookupOrderNum.getAttribute("aria-describedby") || "", /lookupMessage/);
  assert.match(t.els.lookupPhone.getAttribute("aria-describedby") || "", /lookupMessage/);
});

test("order number only: same message, focus phone, no fetch", async () => {
  const t = load();
  await t.submit("CDD-ABC", "  ");
  assert.match(t.msg(), BOTH);
  assert.deepStrictEqual(t.calls, []);
  assert.ok(t.els.lookupPhone._focused, "focus phone when order is present");
  assert.strictEqual(t.els.lookupOrderNum.getAttribute("aria-invalid"), "false");
  assert.strictEqual(t.els.lookupPhone.getAttribute("aria-invalid"), "true");
  assert.strictEqual(t.els.lookupOrderNum.getAttribute("aria-describedby"), null);
  assert.match(t.els.lookupPhone.getAttribute("aria-describedby") || "", /lookupMessage/);
});

test("phone only: same message, focus order number, no fetch", async () => {
  const t = load();
  await t.submit("   ", "3615550100");
  assert.match(t.msg(), BOTH);
  assert.deepStrictEqual(t.calls, []);
  assert.ok(t.els.lookupOrderNum._focused);
  assert.strictEqual(t.els.lookupOrderNum.getAttribute("aria-invalid"), "true");
  assert.strictEqual(t.els.lookupPhone.getAttribute("aria-invalid"), "false");
  assert.match(t.els.lookupOrderNum.getAttribute("aria-describedby") || "", /lookupMessage/);
  assert.strictEqual(t.els.lookupPhone.getAttribute("aria-describedby"), null);
});

test("blank then retry with both filled clears aria-invalid before fetch", async () => {
  const t = load();
  await t.submit("", "");
  assert.strictEqual(t.els.lookupOrderNum.getAttribute("aria-invalid"), "true");
  // Next submit will hit fetch (throws in this harness) after clearing invalid flags.
  await t.submit("CDD-ABC", "3615550100");
  assert.strictEqual(t.els.lookupOrderNum.getAttribute("aria-invalid"), "false");
  assert.strictEqual(t.els.lookupPhone.getAttribute("aria-invalid"), "false");
  assert.strictEqual(t.els.lookupOrderNum.getAttribute("aria-describedby"), null);
  assert.strictEqual(t.els.lookupPhone.getAttribute("aria-describedby"), null);
  assert.ok(t.calls.length >= 1, "fetch attempted after fields filled");
});

(async () => {
  console.log("track-lookup-blank.test.js");
  let failed = 0;
  for (const [n, f] of tests) {
    try { await f(); console.log("ok - " + n); }
    catch (e) { failed++; console.log("not ok - " + n + "\n  " + (e && e.message)); }
  }
  if (failed) { console.error(`track-lookup-blank: ${failed} failed`); process.exit(1); }
  console.log(`track-lookup-blank: ${tests.length} passed`);
})();
