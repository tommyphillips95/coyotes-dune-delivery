#!/usr/bin/env node
/**
 * Track lookup when the server is down vs when the order really isn't there.
 * Before: a Supabase error on POST /api/get-orders returned 404 "Order not
 * found", and the track page showed "We couldn't find that order" for any
 * 5xx/429 too. A paying customer was told their order didn't exist during an
 * outage. Now the server answers 503 for a database error, and the page says
 * "try again" for 5xx/429 while keeping "couldn't find" for 404 (wrong
 * number or phone; same text for both, so no enumeration).
 * Runs the real track.js in a vm and get-orders with Supabase faked.
 */
"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const Module = require("module");
const { createFakeSupabase } = require("./helpers/fake-supabase");

process.env.JWT_SECRET = "test-track-lookup-secret-32-bytes!";
process.env.SUPABASE_URL = "https://fake.supabase.test";
process.env.SUPABASE_SERVICE_KEY = "fake-service-key";
let fake = null;
const realLoad = Module._load;
Module._load = function (request) {
  if (request === "@supabase/supabase-js") return { createClient: () => fake };
  return realLoad.apply(this, arguments);
};

const ROOT = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(ROOT, "frontend/track/index.html"), "utf8");
const src = fs.readFileSync(path.join(ROOT, "frontend/track/track.js"), "utf8");
const coastalSrc = fs.readFileSync(path.join(ROOT, "frontend/js/coastal.js"), "utf8");
const getOrders = require(path.join(ROOT, "netlify/functions/get-orders.js"));

const NOT_FOUND = /couldn't find that order/;
const TRY_AGAIN = /couldn't look up your order right now/;

function el(id) {
  const classes = new Set();
  return {
    id, textContent: "", value: "", hidden: false, disabled: false, listeners: {},
    classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c), contains: (c) => classes.has(c), toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)) },
    addEventListener(t, f) { this.listeners[t] = f; }, focus() {},
  };
}

/** routes: { post: [status, body], get: [status, body] } */
function load(routes, storedToken) {
  const els = {};
  [...html.matchAll(/\bid="([^"]+)"/g)].forEach((m) => { els[m[1]] = el(m[1]); });
  const json = ([status, body]) => ({ ok: status < 300, status, json: async () => { if (body === undefined) throw new SyntaxError("not json"); return body; } });
  const calls = [];
  const fetch = async (url, init) => {
    const kind = /get-orders/.test(url) ? (init && init.method === "POST" ? "post" : "get") : "loc";
    calls.push(kind);
    if (kind === "loc") return json([404, { success: false }]);
    return json(routes[kind]);
  };
  const store = {};
  const window = {
    location: { search: "" }, addEventListener() {}, matchMedia: () => ({ matches: false }),
    localStorage: { getItem: (k) => store[k] || null, setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } },
  };
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
  const submit = async (phone = "3615550100") => {
    els.lookupOrderNum.value = "CDD-TEST1"; els.lookupPhone.value = phone;
    await els.lookupForm.listeners.submit({ preventDefault() {} });
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
  };
  return { els, submit, calls, msg: () => els.lookupMessage.textContent };
}

const tests = [];
const test = (n, f) => tests.push([n, f]);

for (const status of [500, 502, 503, 504, 429]) {
  test(`token request ${status}: 'try again', not 'couldn't find'`, async () => {
    const t = load({ post: [status, status === 502 ? undefined : { error: "x" }] });
    await t.submit();
    assert.match(t.msg(), TRY_AGAIN);
    assert.doesNotMatch(t.msg(), NOT_FOUND);
    assert.strictEqual(t.els.lookupBtn.disabled, false, "button re-enabled");
  });
}

test("order fetch 503 after a good token: 'try again'", async () => {
  const t = load({ post: [200, { token: "t", orderNumber: "CDD-TEST1" }], get: [503, { error: "x" }] });
  await t.submit();
  assert.match(t.msg(), TRY_AGAIN);
});

test("saved token, order fetch 500, no phone typed: 'try again'", async () => {
  const t = load({ get: [500, undefined] }, "saved");
  await t.submit("");
  assert.match(t.msg(), TRY_AGAIN);
  assert.deepStrictEqual(t.calls, ["get"]);
});

test("expired saved token, re-mint 503: 'try again'", async () => {
  const t = load({ get: [401, {}], post: [503, {}] }, "old");
  await t.submit();
  assert.match(t.msg(), TRY_AGAIN);
});

test("404 (wrong number or phone) still says 'couldn't find'", async () => {
  const t = load({ post: [404, { error: "Order not found" }] });
  await t.submit();
  assert.match(t.msg(), NOT_FOUND);
});

// ── server ────────────────────────────────────────────────────────────────
const mint = (order_number, phone) => getOrders.handler({ httpMethod: "POST", headers: {}, body: JSON.stringify({ order_number, phone }) });
const quiet = async (f) => { const e = console.error; console.error = () => {}; try { return await f(); } finally { console.error = e; } };

test("server: database error on lookup is 503, not 404", async () => {
  fake = createFakeSupabase({ orders: [] });
  const from = fake.from;
  fake.from = (name) => { const q = from(name); q.then = (res) => res({ data: null, error: { message: "connection refused" } }); return q; };
  const res = await quiet(() => mint("CDD-AAA111", "3615550100"));
  assert.strictEqual(res.statusCode, 503);
  assert.doesNotMatch(res.body, /not found|connection refused/i, "no internals, no not-found");
});

test("server: unknown order and wrong phone are still the same 404", async () => {
  fake = createFakeSupabase({ orders: [{ id: "a", order_number: "CDD-AAA111", customer: { phone: "(361) 555-0100" } }] });
  const a = await mint("CDD-NOPE", "3615550100");
  const b = await mint("CDD-AAA111", "3615550199");
  assert.deepStrictEqual([a.statusCode, a.body], [404, b.body]);
  assert.strictEqual(b.statusCode, 404);
});

(async () => {
  console.log("track-lookup-errors.test.js");
  let failed = 0;
  for (const [n, f] of tests) {
    try { await f(); console.log("ok - " + n); } catch (e) { failed++; console.log("not ok - " + n + "\n  " + (e && e.message)); }
  }
  if (failed) { console.error(`track-lookup-errors: ${failed} failed`); process.exit(1); }
  console.log(`track-lookup-errors: ${tests.length} passed`);
})();
