#!/usr/bin/env node
// /track/ error states: a stalled request ends in a message (not "Tracking..."
// forever), a 200 that isn't JSON says "try again", and a cut-off ?order= link
// says so. Real track.js in a vm (no network).
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
function load(opts = {}) {
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
    if (state.mode === "hang") return new Promise(() => {});
    if (state.mode === "html" && /get-orders/.test(url)) return { ok: true, status: 200, json: async () => { throw new SyntaxError("Unexpected token <"); } };
    if (/get-orders/.test(url) && init && init.method === "POST") return json({ token: "t", orderNumber: state.order.order_number });
    if (/get-orders/.test(url)) return json({ data: state.order });
    if (/get-driver-location/.test(url)) return state.location
      ? json({ success: true, data: { location: state.location, driver: { first_name: "Val", last_name: "D", vehicle_make: "Toyota", vehicle_model: "Tacoma", vehicle_color: "Silver" } } })
      : json({ success: false }, 404);
    throw new Error("unexpected fetch " + url);
  };
  const store = {};
  const window = {
    location: { search: opts.search || "" }, addEventListener() {}, matchMedia: () => ({ matches: false }),
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
  if (opts.patch) opts.patch(window.CoyoteCoastal, state);
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
const flush = () => new Promise((r) => setImmediate(r));
// Timeout stand-in: the real C.timedFetch aborts after requestTimeoutMs; here it
// rejects at once when the request would hang, like the abort does.
const fastTimeout = (C, state) => {
  const real = C.timedFetch;
  C.timedFetch = (f, url, init, ms) => { state.timeoutMs = ms; if (state.mode === "hang") { const e = new Error("timeout"); e.timedOut = true; e.network = true; return Promise.reject(e); } return real(f, url, init, ms); };
};

test("stalled lookup ends with a message and Track Order re-enabled", async () => {
  const t = load({ patch: fastTimeout });
  t.state.order = order("assigned"); t.state.mode = "hang";
  const p = t.submit();
  await Promise.race([p, new Promise((r) => setTimeout(r, 300))]);
  await flush();
  assert.strictEqual(t.els.lookupBtn.disabled, false, "not stuck on Tracking...");
  assert.strictEqual(t.els.lookupBtn.textContent, "Track Order");
  assert.ok(!t.els.lookupMessage.hidden && /try again/.test(t.els.lookupMessage.textContent), t.els.lookupMessage.textContent);
  assert.ok(t.state.timeoutMs > 0);
});

test("200 that isn't JSON: 'try again', not 'couldn't find that order'", async () => {
  const t = load();
  t.state.order = order("assigned"); t.state.mode = "html";
  await t.submit();
  assert.match(t.els.lookupMessage.textContent, /couldn't look up your order right now/);
  assert.doesNotMatch(t.els.lookupMessage.textContent, /couldn't find/);
});

test("cut-off ?order= link: says so; a valid one or no param stays quiet", () => {
  assert.match(load({ search: "?order=%3Cx%3E" }).els.lookupMessage.textContent, /tracking link isn't complete/);
  assert.strictEqual(load({ search: "" }).els.lookupMessage.textContent, "");
  assert.doesNotMatch(load({ search: "?order=CDD-TEST1" }).els.lookupMessage.textContent, /isn't complete/);
});

// A hung await would let node exit 0 with tests unrun; fail loudly instead.
const guard = setTimeout(() => { console.error("not ok - timed out (a request hung)"); process.exit(1); }, 5000);
(async () => {
  let failed = 0;
  for (const [n, f] of tests) {
    try { await f(); console.log("ok -", n); } catch (e) { failed++; console.error("not ok -", n, "\n ", e.message); }
  }
  clearTimeout(guard);
  process.exit(failed ? 1 : 0);
})();
