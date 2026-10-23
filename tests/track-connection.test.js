#!/usr/bin/env node
/**
 * Track page refresh failures. Before: every failed 15s refresh was only
 * console.error'd, so on a bad beach signal the page silently showed stale
 * status forever. Now, after 3 failed refreshes in a row (network error, 5xx
 * or 429), a role="status" "Connection lost, retrying…" notice shows once,
 * retries back off (15s, 30s, 60s, capped at 120s) and the first good refresh
 * clears it. Real track.js in a vm; fetch, timers and the clock are faked.
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

function el(id) {
  const classes = new Set();
  return {
    id, textContent: "", value: "", hidden: false, disabled: false, listeners: {}, sets: 0,
    classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c), contains: (c) => classes.has(c), toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)) },
    addEventListener(t, f) { this.listeners[t] = f; }, focus() {},
  };
}

const ORDER = { id: "o1", order_number: "CDD-TEST1", status: "assigned", driver_id: "d1", service_type: "ride", pickup_address: "1 A St", dropoff_address: "2 B St" };

function load() {
  const els = {};
  [...html.matchAll(/\bid="([^"]+)"/g)].forEach((m) => { els[m[1]] = el(m[1]); });
  const notice = els.connectionNotice;
  if (notice) { let t = ""; Object.defineProperty(notice, "textContent", { get: () => t, set: (v) => { t = v; notice.sets++; } }); }
  const state = { mode: "ok", clock: 1e12, orderGets: 0, timer: null };
  const res = (status, body) => ({ ok: status < 300, status, json: async () => { if (body === undefined) throw new SyntaxError("x"); return body; } });
  const fetch = async (url, init) => {
    if (/get-orders/.test(url) && init && init.method === "POST") return res(200, { token: "t", orderNumber: ORDER.order_number });
    if (/get-orders/.test(url)) {
      state.orderGets++;
      if (state.mode === "network") throw new TypeError("Load failed");
      if (state.mode === "503") return res(503, undefined);
      if (state.mode === "429") return res(429, {});
      return res(200, { data: ORDER });
    }
    return res(404, { success: false });
  };
  const store = {};
  const window = { location: { search: "" }, addEventListener() {}, matchMedia: () => ({ matches: false }),
    localStorage: { getItem: (k) => store[k] || null, setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } } };
  const FakeDate = class extends Date { static now() { return state.clock; } };
  const ctx = {
    window, document: { getElementById: (id) => els[id] || null }, fetch, console: { error() {}, log() {} }, Date: FakeDate,
    L: { map: () => ({ setView() { return this; }, invalidateSize() {}, fitBounds() {} }), tileLayer: () => ({ addTo() {} }), marker: () => ({ addTo() { return this; }, bindPopup() { return this; } }), latLngBounds: () => ({ pad() { return {}; } }), Browser: { mobile: false } },
    localStorage: window.localStorage, sessionStorage: window.localStorage,
    setInterval: (f, ms) => { state.timer = { f, ms }; return 1; }, clearInterval() { state.timer = null; }, setTimeout: () => 0, clearTimeout() {},
    URLSearchParams, alert() {}, ResizeObserver: undefined,
  };
  window.window = window; window.document = ctx.document;
  vm.createContext(ctx);
  vm.runInContext(coastalSrc, ctx);
  ctx.CoyoteCoastal = window.CoyoteCoastal;
  vm.runInContext(src, ctx);
  const flush = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)); };
  const submit = async () => { els.lookupOrderNum.value = ORDER.order_number; els.lookupPhone.value = "3615550100"; await els.lookupForm.listeners.submit({ preventDefault() {} }); await flush(); };
  // Advance the clock one 15s interval and fire the timer.
  const step = async () => { state.clock += state.timer.ms; await state.timer.f(); await flush(); };
  const shown = () => !!notice && !notice.hidden && /Connection lost, retrying/.test(notice.textContent);
  return { els, state, submit, step, shown, notice };
}

const tests = [];
const test = (n, f) => tests.push([n, f]);

test("notice element exists, is announced (role=status, aria-live) and starts hidden", () => {
  const m = /<p[^>]*id="connectionNotice"[^>]*>/.exec(html);
  assert(m, "#connectionNotice");
  assert(/role="status"/.test(m[0]) && /aria-live="polite"/.test(m[0]) && /\shidden[\s>]/.test(m[0]));
});

for (const mode of ["network", "503", "429"]) {
  test(`${mode}: notice after 3 failed refreshes in a row, cleared by the next good one`, async () => {
    const t = load();
    await t.submit();
    assert(!t.shown());
    t.state.mode = mode;
    for (let i = 0; i < 2; i++) { t.state.clock += 120000; await t.step(); }
    assert(!t.shown(), "not after 2");
    t.state.clock += 120000; await t.step();
    assert(t.shown(), "shown after 3");
    t.state.mode = "ok";
    t.state.clock += 120000; await t.step();
    assert(!t.shown(), "cleared");
    assert.strictEqual(t.notice.textContent, "");
  });
}

test("backoff: retries at 15s, 30s, 60s, then capped at 120s; skipped ticks make no request", async () => {
  const t = load();
  await t.submit();
  t.state.mode = "network";
  const attemptsAt = [];
  for (let i = 1; i <= 30; i++) { const before = t.state.orderGets; await t.step(); if (t.state.orderGets > before) attemptsAt.push(i * 15); }
  const gaps = attemptsAt.slice(1).map((x, i) => x - attemptsAt[i]);
  assert.deepStrictEqual(gaps.slice(0, 5), [15, 30, 60, 120, 120], "seconds between attempts: " + attemptsAt);
  assert(attemptsAt.length < 10, "no spam: " + attemptsAt.length + " requests in 7.5 min");
});

test("notice text is set once while failing (not re-announced every retry)", async () => {
  const t = load();
  await t.submit();
  t.state.mode = "503";
  for (let i = 0; i < 8; i++) { t.state.clock += 120000; await t.step(); }
  assert(t.shown());
  assert.strictEqual(t.notice.sets, 1);
});

test("after recovery the 15s refresh resumes with no backoff", async () => {
  const t = load();
  await t.submit();
  t.state.mode = "network";
  for (let i = 0; i < 4; i++) { t.state.clock += 120000; await t.step(); }
  t.state.mode = "ok";
  t.state.clock += 120000; await t.step();
  const before = t.state.orderGets;
  await t.step(); await t.step();
  assert.strictEqual(t.state.orderGets - before, 2);
});

(async () => {
  console.log("track-connection.test.js");
  let failed = 0;
  for (const [n, f] of tests) {
    try { await f(); console.log("ok - " + n); } catch (e) { failed++; console.log("not ok - " + n + "\n  " + (e && e.message)); }
  }
  if (failed) { console.error(`track-connection: ${failed} failed`); process.exit(1); }
  console.log(`track-connection: ${tests.length} passed`);
})();
