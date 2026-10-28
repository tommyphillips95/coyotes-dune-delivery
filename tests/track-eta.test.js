#!/usr/bin/env node
// /track/ ETA card follows the leg the driver is on, and finished or
// driverless orders never show a live driver or a countdown.
// Before: ETA was always driver -> drop-off (wrong while the driver heads to
// the pickup), and a cancelled/completed order still showed "Live Tracking,
// Estimated Arrival N minutes" plus the GPS driver's name.
// Runs the real frontend/track/track.js in a vm with a tiny fake DOM, fetch
// and Leaflet. No network.
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

function el(id) {
  const classes = new Set();
  return {
    id, textContent: "", value: "", hidden: false, disabled: false, listeners: {},
    classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c), contains: (c) => classes.has(c), toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)) },
    addEventListener(t, f) { this.listeners[t] = f; }, focus() {},
  };
}

/** Load track.js with fakes; returns helpers to drive it. */
function load() {
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);
  const els = {};
  ids.forEach((id) => { els[id] = el(id); });
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
  const json = (body, status = 200) => ({ ok: status < 300, status, json: async () => body });
  const fetch = async (url, init) => {
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
    window, document: { getElementById: (id) => els[id] || null }, fetch, L, console: { error() {}, log() {} },
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
  return { els, state, submit, eta, driverDot };
}

const order = (status, over) => Object.assign({ id: "o1", order_number: "CDD-TEST1", status, driver_id: "d1", service_type: "ride",
  pickup_address: "1 Pickup St", pickup_lat: PICKUP.lat, pickup_lng: PICKUP.lng, dropoff_address: "9 Beach Rd", dropoff_lat: DROPOFF.lat, dropoff_lng: DROPOFF.lng }, over);

const tests = [];
const test = (n, f) => tests.push([n, f]);

test("assigned: ETA is driver -> pickup (≈3 min), not driver -> drop-off (≈20 min)", async () => {
  const t = load();
  t.state.order = order("assigned"); t.state.location = NEAR_PICKUP;
  await t.submit();
  assert.deepStrictEqual(t.eta(), { visible: true, label: "Driver arrives at pickup in", value: "3", unit: "minutes" });
  assert.strictEqual(t.els.driverName.textContent, "Val D");
});

test("in progress: ETA is driver -> drop-off", async () => {
  const t = load();
  t.state.order = order("in_progress"); t.state.location = NEAR_PICKUP;
  await t.submit();
  assert.deepStrictEqual(t.eta(), { visible: true, label: "Arrival at drop-off in", value: "20", unit: "minutes" });
});

test("in progress with no drop-off coordinates: no made-up number", async () => {
  const t = load();
  t.state.order = order("in_progress", { dropoff_lat: null, dropoff_lng: null }); t.state.location = NEAR_PICKUP;
  await t.submit();
  assert.strictEqual(t.eta().value, "--");
});

test("assigned, driver hasn't shared GPS yet: says so", async () => {
  const t = load();
  t.state.order = order("assigned"); t.state.location = null;
  await t.submit();
  assert.deepStrictEqual(t.eta(), { visible: true, label: "Driver arrives at pickup in", value: "--", unit: "Shown once your driver shares their location" });
});

for (const [status, name] of [["cancelled", "Order cancelled"], ["completed", "Trip completed"]]) {
  test(`${status}: no live ETA card, no driver dot, driver card says "${name}"`, async () => {
    const t = load();
    t.state.order = order(status); t.state.location = NEAR_PICKUP;
    await t.submit();
    assert.strictEqual(t.eta().visible, false, "ETA card hidden");
    assert.strictEqual(t.driverDot(), null, "no driver marker");
    assert.strictEqual(t.els.driverName.textContent, name, "GPS driver name must not replace the final text");
  });
}

test("unassigned (pending, no driver) with an old GPS ping for the order: no driver dot or countdown", async () => {
  const t = load();
  t.state.order = order("pending", { driver_id: null }); t.state.location = NEAR_PICKUP;
  await t.submit();
  assert.strictEqual(t.driverDot(), null);
  assert.strictEqual(t.eta().value, "--");
  assert.strictEqual(t.els.driverName.textContent, "Not assigned yet");
});

test("dispatch cancels while the customer watches (assigned -> cancelled on the next poll): live card and dot go away", async () => {
  const t = load();
  t.state.order = order("assigned"); t.state.location = NEAR_PICKUP;
  await t.submit();
  assert.ok(t.driverDot() && t.eta().visible);
  t.state.order = order("cancelled");
  await t.state.tick();
  assert.strictEqual(t.eta().visible, false);
  assert.strictEqual(t.driverDot(), null);
  assert.strictEqual(t.els.driverName.textContent, "Order cancelled");
});

test("assigned -> in progress on the next poll: ETA switches from pickup to drop-off", async () => {
  const t = load();
  t.state.order = order("assigned"); t.state.location = NEAR_PICKUP;
  await t.submit();
  assert.strictEqual(t.eta().label, "Driver arrives at pickup in");
  t.state.order = order("in_progress");
  await t.state.tick();
  assert.deepStrictEqual([t.eta().label, t.eta().value], ["Arrival at drop-off in", "20"]);
});

test("HTML: ETA label is a live element; track page headings go h1 -> h2 (no skipped level)", () => {
  assert.ok(/<div id="etaLabel">Estimated arrival<\/div>/.test(html));
  const levels = [...html.matchAll(/<h([1-6])\b/g)].map((m) => +m[1]);
  assert.strictEqual(levels[0], 1);
  levels.forEach((l, i) => assert.ok(i === 0 || l <= levels[i - 1] + 1, "heading jumps to h" + l));
  assert.ok(!/<h3>Find Your Order<\/h3>/.test(html));
});

(async () => {
  let failed = 0;
  for (const [n, f] of tests) {
    try { await f(); console.log("ok -", n); } catch (e) { failed++; console.error("not ok -", n, "\n ", e.stack); }
  }
  console.log(failed ? `${failed} failed` : `track-eta: ${tests.length} passed`);
  process.exit(failed ? 1 : 0);
})();
