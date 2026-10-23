#!/usr/bin/env node
// /track/ accessibility: the current timeline step is exposed (aria-current),
// status changes from polling are announced, and keyboard focus is not left
// on <body> after a lookup. Real track.js in a vm (no network).
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(ROOT, "frontend/track/index.html"), "utf8");
const src = fs.readFileSync(path.join(ROOT, "frontend/track/track.js"), "utf8");
const coastalSrc = fs.readFileSync(path.join(ROOT, "frontend/js/coastal.js"), "utf8");

const PICKUP = { lat: 27.8339, lng: -97.0611 };   // Port Aransas
const DROPOFF = { lat: 27.75, lng: -97.12 };      // ~6.5 mi south
const NEAR_PICKUP = { lat: 27.845, lng: -97.07 }; // ~1 mi from pickup

const doc = { activeElement: null };
function el(id) {
  const classes = new Set();
  const attrs = {};
  return {
    attrs, setAttribute(k, v) { attrs[k] = String(v); }, removeAttribute(k) { delete attrs[k]; }, getAttribute(k) { return k in attrs ? attrs[k] : null; },
    id, textContent: "", value: "", hidden: false, disabled: false, listeners: {},
    classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c), contains: (c) => classes.has(c), toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)) },
    addEventListener(t, f) { this.listeners[t] = f; }, focus() { doc.activeElement = this; },
  };
}

/** Load track.js with fakes; returns helpers to drive it. */
function load() {
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);
  const els = {};
  ids.forEach((id) => { els[id] = el(id); });
  const steps = {};
  ["dotPending", "dotAssigned", "dotInProgress", "dotCompleted"].forEach((id) => { steps[id] = el("step-" + id); els[id].parentElement = steps[id]; });
  const body = el("body"); doc.activeElement = body;
  ["etaCard", "driverCard", "orderCard", "timelineCard", "map", "mapError"].forEach((id) => els[id].classList.add("hidden"));
  const state = { order: null, location: null };
  const markers = [];
  const fakeMap = { setView() { return fakeMap; }, invalidateSize() {}, fitBounds() {}, removeLayer(m) { m.removed = true; } };
  const L = {
    map: () => fakeMap,
    tileLayer: () => ({ addTo() {} }),
    marker: (ll) => { const m = { ll, addTo() { return m; }, bindPopup() { return m; }, getLatLng: () => ({ lat: ll[0], lng: ll[1] }) }; return m; },
    circleMarker: (ll) => { const m = { ll, driver: true, addTo() { markers.push(m); return m; }, bindPopup() { return m; }, setLatLng(x) { m.ll = x; }, getLatLng: () => ({ lat: m.ll[0], lng: m.ll[1] }) }; return m; },
    latLngBounds: () => ({ pad() { return {}; } }),
    Browser: { mobile: false },
  };
  state.calls = []; const json = (body, status = 200) => ({ ok: status < 300, status, json: async () => body });
  const fetch = async (url, init) => { state.calls.push(url);
    if (/get-orders/.test(url) && init && init.method === "POST") return json({ token: "t", orderNumber: state.order.order_number });
    if (/get-orders/.test(url)) return json({ data: state.order });
    if (/get-driver-location/.test(url)) return state.location
      ? json({ success: true, data: { location: state.location, driver: { first_name: "Val", last_name: "D", vehicle_make: "Toyota", vehicle_model: "Tacoma", vehicle_color: "Silver" } } })
      : json({ success: false }, 404);
    throw new Error("unexpected fetch " + url);
  };
  const store = {};
  const window = {
    location: { search: "" }, addEventListener() {}, matchMedia: () => ({ matches: false }),
    localStorage: { getItem: (k) => store[k] || null, setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } },
  };
  const ctx = {
    window, document: { getElementById: (id) => els[id] || null, body, get activeElement() { return doc.activeElement; } }, fetch, L, console: { error() {}, log() {} },
    localStorage: window.localStorage, sessionStorage: window.localStorage, setInterval: (f) => { state.tick = f; return 1; }, clearInterval() {}, setTimeout: (f) => 0, clearTimeout() {},
    URLSearchParams, alert() {}, ResizeObserver: undefined,
  };
  window.window = window; window.document = ctx.document;
  vm.createContext(ctx);
  vm.runInContext(coastalSrc, ctx);
  ctx.CoyoteCoastal = window.CoyoteCoastal;
  vm.runInContext(src, ctx);
  const submit = async () => {
    els.lookupOrderNum.value = state.order.order_number; els.lookupPhone.value = "3615550100";
    await els.lookupForm.listeners.submit({ preventDefault() {} });
    await new Promise((r) => setImmediate(r));
  };
  const driverDot = () => markers.filter((m) => !m.removed).pop() || null;
  const eta = () => ({ visible: !els.etaCard.classList.contains("hidden"), label: els.etaLabel.textContent, value: els.etaValue.textContent, unit: els.etaUnit.textContent });
  return { els, state, submit, eta, driverDot, steps, body };
}
const order = (status, over) => Object.assign({ id: "o1", order_number: "CDD-TEST1", status, driver_id: "d1", service_type: "ride", pickup_address: "1 Pickup St", pickup_lat: PICKUP.lat, pickup_lng: PICKUP.lng, dropoff_address: "9 Beach Rd", dropoff_lat: DROPOFF.lat, dropoff_lng: DROPOFF.lng }, over);
const tests = [];
const test = (n, f) => tests.push([n, f]);
const current = (t) => Object.keys(t.steps).filter((k) => t.steps[k].getAttribute("aria-current") === "step");

test("timeline marks exactly the current step with aria-current=step", async () => {
  const t = load();
  t.state.order = order("assigned");
  await t.submit();
  assert.deepStrictEqual(current(t), ["dotAssigned"]);
  t.state.order = order("in_progress");
  await t.state.tick(); await new Promise((r) => setImmediate(r));
  assert.deepStrictEqual(current(t), ["dotInProgress"]);
});

test("status change from polling is announced with the existing label; first render is not", async () => {
  const t = load();
  t.state.order = order("assigned");
  await t.submit();
  assert.strictEqual(t.els.trackStatusLive.textContent, "", "first render silent");
  await t.state.tick(); await new Promise((r) => setImmediate(r));
  assert.strictEqual(t.els.trackStatusLive.textContent, "", "same status: no repeat");
  t.state.order = order("in_progress");
  await t.state.tick(); await new Promise((r) => setImmediate(r));
  assert.strictEqual(t.els.trackStatusLive.textContent, "Status: " + t.els.detailStatus.textContent);
  assert.strictEqual(t.els.detailStatus.textContent, "On the Way");
});

test("live region is a polite status region, visually hidden", () => {
  assert.ok(/<div class="cc-sr-only" id="trackStatusLive" role="status" aria-live="polite"><\/div>/.test(html));
});

test("after a lookup, focus returns to Track Order instead of <body>", async () => {
  const t = load();
  t.state.order = order("assigned");
  doc.activeElement = t.els.lookupBtn; // user pressed Track Order
  const orig = t.els.lookupBtn; let blurred = false;
  // Disabling a focused button blurs it in browsers; model that.
  Object.defineProperty(orig, "disabled", { configurable: true, get() { return this._d; }, set(v) { this._d = v; if (v && doc.activeElement === this) { doc.activeElement = t.body; blurred = true; } } });
  await t.submit();
  assert.ok(blurred);
  assert.strictEqual(doc.activeElement, t.els.lookupBtn);
});

test("the automatic lookup from a tracking link does not move focus", async () => {
  const t = load();
  t.state.order = order("assigned");
  assert.strictEqual(doc.activeElement, t.body);
  await t.submit();
  assert.strictEqual(doc.activeElement, t.body);
});

test("a lookup that already moved focus to a field keeps it there", async () => {
  const t = load();
  t.state.order = order("assigned");
  t.els.lookupOrderNum.value = "CDD-TEST1"; t.els.lookupPhone.value = "";
  await t.els.lookupForm.listeners.submit({ preventDefault() {} });
  assert.strictEqual(doc.activeElement, t.els.lookupPhone);
});

(async () => {
  let failed = 0;
  for (const [n, f] of tests) {
    try { await f(); console.log("ok -", n); } catch (e) { failed++; console.error("not ok -", n, "\n ", e.message); }
  }
  process.exit(failed ? 1 : 0);
})();
