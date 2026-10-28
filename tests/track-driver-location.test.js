#!/usr/bin/env node
/**
 * Track page driver-location request. Before: the response body was read
 * with res.json() whatever the status, so a 404 ("no location yet"), a 5xx
 * or a proxy's HTML error page was parsed as if it were a location. Non-JSON
 * bodies threw and were console.error'd on every 15s refresh. Now !res.ok is
 * skipped without reading the body, and an unparseable body is ignored
 * quietly. A good 200 still moves the driver dot. Real track.js in a vm.
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

const ORDER = { id: "o1", order_number: "CDD-TEST1", status: "assigned", driver_id: "d1", service_type: "ride",
  pickup_address: "1 Pickup St", pickup_lat: 27.8339, pickup_lng: -97.0611, dropoff_address: "9 Beach Rd", dropoff_lat: 27.75, dropoff_lng: -97.12 };
const LOC = { lat: 27.845, lng: -97.07 };
const GOOD = { success: true, data: { location: LOC, driver: { first_name: "Val", last_name: "D" } } };

/** loc: [status, body] — body undefined means non-JSON (json() throws). */
async function run(loc) {
  const els = {};
  [...html.matchAll(/\bid="([^"]+)"/g)].forEach((m) => {
    const classes = new Set();
    els[m[1]] = { id: m[1], textContent: "", value: "", hidden: false, disabled: false, listeners: {}, style: {},
      classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c), contains: (c) => classes.has(c), toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)) },
      addEventListener(t, f) { this.listeners[t] = f; }, focus() {} };
  });
  const dots = [];
  const fakeMap = { setView() { return fakeMap; }, invalidateSize() {}, fitBounds() {}, removeLayer() {} };
  const L = {
    map: () => fakeMap, tileLayer: () => ({ addTo() {} }),
    marker: (ll) => { const m = { ll, addTo() { return m; }, bindPopup() { return m; }, getLatLng: () => ({ lat: ll[0], lng: ll[1] }) }; return m; },
    circleMarker: (ll) => { const m = { ll, addTo() { dots.push(m); return m; }, bindPopup() { return m; }, setLatLng(x) { m.ll = x; }, getLatLng: () => ({ lat: m.ll[0], lng: m.ll[1] }) }; return m; },
    latLngBounds: () => ({ pad() { return {}; } }), Browser: { mobile: false },
  };
  const s = { locJsonReads: 0, errors: [] };
  const res = (status, body, isLoc) => ({ ok: status >= 200 && status < 300, status,
    json: async () => { if (isLoc) s.locJsonReads++; if (body === undefined) throw new SyntaxError("Unexpected token '<'"); return body; } });
  const fetch = async (url, init) => {
    if (/get-orders/.test(url) && init && init.method === "POST") return res(200, { token: "t", orderNumber: ORDER.order_number });
    if (/get-orders/.test(url)) return res(200, { data: ORDER });
    if (/get-driver-location/.test(url)) return res(loc[0], loc[1], true);
    throw new Error("unexpected fetch " + url);
  };
  const store = {};
  const window = { location: { search: "" }, addEventListener() {}, matchMedia: () => ({ matches: false }),
    localStorage: { getItem: (k) => store[k] || null, setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } } };
  const ctx = {
    window, document: { getElementById: (id) => els[id] || null }, fetch, L,
    console: { error: (...a) => s.errors.push(a), log() {}, warn() {} },
    localStorage: window.localStorage, sessionStorage: window.localStorage, setInterval: () => 1, clearInterval() {}, setTimeout: () => 0, clearTimeout() {},
    URLSearchParams, alert() {}, ResizeObserver: undefined,
  };
  window.window = window; window.document = ctx.document;
  vm.createContext(ctx);
  vm.runInContext(coastalSrc, ctx);
  ctx.CoyoteCoastal = window.CoyoteCoastal;
  vm.runInContext(src, ctx);
  els.lookupOrderNum.value = ORDER.order_number; els.lookupPhone.value = "3615550100";
  await els.lookupForm.listeners.submit({ preventDefault() {} });
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
  return { els, dots, s };
}

const tests = [];
const test = (n, f) => tests.push([n, f]);

test("200 with a location: driver dot drawn and driver name shown", async () => {
  const t = await run([200, GOOD]);
  assert.strictEqual(t.dots.length, 1);
  assert.strictEqual(t.els.driverName.textContent, "Val D");
  assert.deepStrictEqual(t.s.errors, []);
});

for (const [status, body, label] of [
  [404, { success: false, error: "No location" }, "404 JSON"],
  [500, undefined, "500 HTML page"],
  [502, undefined, "502 proxy page"],
  [429, { error: "Too many requests" }, "429 JSON"],
]) {
  test(`${label}: body not read, no dot, nothing logged`, async () => {
    const t = await run([status, body]);
    assert.strictEqual(t.s.locJsonReads, 0, "res.json() called on a non-ok response");
    assert.strictEqual(t.dots.length, 0);
    assert.deepStrictEqual(t.s.errors, []);
  });
}

test("error status whose body looks like a location is still ignored", async () => {
  const t = await run([500, GOOD]);
  assert.strictEqual(t.dots.length, 0);
  assert.notStrictEqual(t.els.driverName.textContent, "Val D");
});

test("200 with a non-JSON body: ignored quietly", async () => {
  const t = await run([200, undefined]);
  assert.strictEqual(t.dots.length, 0);
  assert.deepStrictEqual(t.s.errors, []);
});

test("200 with JSON null: ignored quietly", async () => {
  const t = await run([200, null]);
  assert.strictEqual(t.dots.length, 0);
  assert.deepStrictEqual(t.s.errors, []);
});

(async () => {
  console.log("track-driver-location.test.js");
  let failed = 0;
  for (const [n, f] of tests) {
    try { await f(); console.log("ok - " + n); } catch (e) { failed++; console.log("not ok - " + n + "\n  " + (e && e.message)); }
  }
  if (failed) { console.error(`track-driver-location: ${failed} failed`); process.exit(1); }
  console.log(`track-driver-location: ${tests.length} passed`);
})();
