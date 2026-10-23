#!/usr/bin/env node
// /track/ shows "Paid" once the order's real payment_status is paid; the
// status labels are unchanged. Real track.js in a vm (no network).
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
const order = (status, over) => Object.assign({ id: "o1", order_number: "CDD-TEST1", status, driver_id: "d1", service_type: "ride", pickup_address: "1 Pickup St", pickup_lat: PICKUP.lat, pickup_lng: PICKUP.lng, dropoff_address: "9 Beach Rd", dropoff_lat: DROPOFF.lat, dropoff_lng: DROPOFF.lng }, over);
const tests = [];
const test = (n, f) => tests.push([n, f]);

for (const [ps, pi, shown, label] of [["paid", "pi_1", true, "Paid"], ["pending", "pi_1", false, ""], ["failed", "pi_1", false, ""], ["pending", null, false, ""]]) {
  test(`payment_status=${ps} (${pi ? "card" : "pay driver"}): Paid row ${shown ? "shown" : "hidden"}; status label unchanged`, async () => {
    const t = load();
    t.state.order = order("pending", { driver_id: null, payment_status: ps, stripe_payment_intent_id: pi });
    await t.submit();
    assert.strictEqual(t.els.detailPaymentRow.hidden, !shown);
    assert.strictEqual(t.els.detailPayment.textContent, label);
    assert.strictEqual(t.els.detailStatus.textContent, "Pending");
  });
}

test("partial refund keeps the existing badge wording", async () => {
  const t = load();
  t.state.order = order("assigned", { payment_status: "paid", stripe_payment_intent_id: "pi_1", status_logs: [{ status: "partial_refund" }] });
  await t.submit();
  assert.strictEqual(t.els.detailPayment.textContent, "Paid (partly refunded)");
  assert.strictEqual(t.els.detailStatus.textContent, "Assigned");
});

test("hidden row really hides (display:flex would override [hidden])", () => {
  assert.ok(/\.order-detail-row\[hidden\]\s*\{\s*display:\s*none/.test(html));
});

(async () => {
  let failed = 0;
  for (const [n, f] of tests) {
    try { await f(); console.log("ok -", n); } catch (e) { failed++; console.error("not ok -", n, "\n ", e.message); }
  }
  process.exit(failed ? 1 : 0);
})();
