#!/usr/bin/env node
/**
 * Confirmation page "Track" link (/track/?track=CDD-…) opened on a device with
 * no saved tracking token. Before: the order number was filled in and nothing
 * else happened, so the page just sat there. Now the phone field is focused
 * and a one-line hint says what to enter. With a saved token it still tracks
 * straight away with no hint. Real track.js in a vm.
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
const HINT = "Enter the phone number used for this order to start tracking.";

function load(search, storedToken) {
  const els = {};
  const focused = [];
  [...html.matchAll(/\bid="([^"]+)"/g)].forEach((m) => {
    const classes = new Set();
    els[m[1]] = { id: m[1], textContent: "", value: "", hidden: true, disabled: false, listeners: {},
      classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c), contains: (c) => classes.has(c), toggle() {} },
      addEventListener(t, f) { this.listeners[t] = f; }, focus() { focused.push(m[1]); } };
  });
  const calls = [];
  const fetch = async (url, init) => {
    calls.push(/get-orders/.test(url) ? (init && init.method === "POST" ? "post" : "get") : "loc");
    return { ok: false, status: 404, json: async () => ({ success: false }) };
  };
  const store = {};
  const window = { location: { search }, addEventListener() {}, matchMedia: () => ({ matches: false }),
    localStorage: { getItem: (k) => store[k] || null, setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } } };
  const ctx = {
    window, document: { getElementById: (id) => els[id] || null }, fetch, console: { error() {}, log() {} },
    L: { map: () => ({ setView() { return this; }, invalidateSize() {}, fitBounds() {} }), tileLayer: () => ({ addTo() {} }), marker: () => ({ addTo() { return this; }, bindPopup() { return this; } }), latLngBounds: () => ({ pad() { return {}; } }), Browser: { mobile: false } },
    localStorage: window.localStorage, sessionStorage: window.localStorage, setInterval: () => 1, clearInterval() {}, setTimeout: () => 0, clearTimeout() {},
    URLSearchParams, alert() {}, ResizeObserver: undefined,
  };
  window.window = window; window.document = ctx.document;
  vm.createContext(ctx);
  vm.runInContext(coastalSrc, ctx);
  ctx.CoyoteCoastal = window.CoyoteCoastal;
  if (storedToken) window.CoyoteCoastal.saveTrackingToken("CDD-TEST1", storedToken);
  vm.runInContext(src, ctx);
  return { els, focused, calls };
}

const tests = [];
const test = (n, f) => tests.push([n, f]);

test("track link, no saved token: order number filled, phone focused, one-line hint shown", () => {
  const t = load("?track=CDD-TEST1");
  assert.strictEqual(t.els.lookupOrderNum.value, "CDD-TEST1");
  assert.deepStrictEqual(t.focused, ["lookupPhone"]);
  assert.strictEqual(t.els.lookupMessage.textContent, HINT);
  assert.strictEqual(t.els.lookupMessage.hidden, false);
  assert(!/\n/.test(HINT));
  assert.deepStrictEqual(t.calls, [], "no request without a phone or token");
});

test("track link with a saved token: tracks straight away, no hint, no phone focus", async () => {
  const t = load("?track=CDD-TEST1", "saved-token");
  await new Promise((r) => setImmediate(r));
  assert.notDeepStrictEqual(t.calls, []);
  assert(!t.focused.includes("lookupPhone"));
  assert.notStrictEqual(t.els.lookupMessage.textContent, HINT);
});

test("plain /track/ (no link): no focus steal, no hint", () => {
  const t = load("");
  assert.deepStrictEqual(t.focused, []);
  assert.strictEqual(t.els.lookupMessage.textContent, "");
});

(async () => {
  console.log("track-autotrack.test.js");
  let failed = 0;
  for (const [n, f] of tests) {
    try { await f(); console.log("ok - " + n); } catch (e) { failed++; console.log("not ok - " + n + "\n  " + (e && e.message)); }
  }
  if (failed) { console.error(`track-autotrack: ${failed} failed`); process.exit(1); }
  console.log(`track-autotrack: ${tests.length} passed`);
})();
