#!/usr/bin/env node
// Slow / dropped connections on order + payment requests:
//  - CoyoteAPI aborts after timeoutMs and reports { status: 0, timedOut } / { offline }
//  - offline short-circuits without sending
//  - retry wiring reuses the same idempotency key + payload, never auto-retries
//    confirmCardPayment, and payment retry goes back through create-payment-intent.
// fetch / timers are mocked; main.js + coastal.js run in a vm with a stub DOM.
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const root = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");

function sandbox(fetchImpl, onLine) {
  const noop = () => {};
  const document = { querySelectorAll: () => [], querySelector: () => null, getElementById: () => null, addEventListener: noop, createElement: () => ({ style: {}, setAttribute: noop, appendChild: noop, classList: { add: noop, remove: noop } }), body: { appendChild: noop } };
  const win = { document, navigator: { onLine: onLine !== false }, localStorage: { getItem: () => null, setItem: noop, removeItem: noop }, addEventListener: noop, location: { pathname: "/order/", search: "" },
    fetch: fetchImpl, AbortController, setTimeout, clearTimeout, console: { error: noop, log: noop, warn: noop }, IntersectionObserver: function () { return { observe: noop }; } };
  win.window = win; win.globalThis = win;
  const ctx = vm.createContext(Object.assign(win, { Promise, Error, Object, JSON, Array, String, Number, Math, Date, URLSearchParams, FormData: function () {} }));
  vm.runInContext(read("frontend/js/coastal.js"), ctx);
  vm.runInContext(read("frontend/js/main.js"), ctx);
  return ctx;
}
const hang = () => (url, cfg) => new Promise((res, rej) => {
  cfg.signal.addEventListener("abort", () => { const e = new Error("The operation was aborted."); e.name = "AbortError"; Object.defineProperty(e, "message", { value: e.message, writable: false }); rej(Object.freeze(e)); });
});
const jsonRes = (status, body) => ({ ok: status < 400, status, headers: { get: () => "application/json" }, json: async () => body, text: async () => JSON.stringify(body) });

const tests = [];
const test = (n, f) => tests.push([n, f]);

test("CoyoteAPI.post with timeoutMs aborts a hung request -> status 0, timedOut", async () => {
  let calls = 0, signal = null;
  const ctx = sandbox((u, c) => { calls++; signal = c.signal; return hang()(u, c); });
  const t0 = Date.now();
  const r = await ctx.CoyoteAPI.post("/api/create-order", { a: 1 }, { timeoutMs: 60 });
  assert.strictEqual(r.ok, false); assert.strictEqual(r.status, 0); assert.strictEqual(r.timedOut, true);
  assert.strictEqual(calls, 1); assert(signal && signal.aborted, "request was aborted");
  assert(Date.now() - t0 < 1000);
  assert.strictEqual(ctx.CoyoteCoastal.networkFailureKind(r), "timeout");
});

test("offline: nothing is sent; result says offline", async () => {
  let calls = 0;
  const ctx = sandbox(() => { calls++; return Promise.resolve(jsonRes(200, {})); }, false);
  const r = await ctx.CoyoteAPI.post("/api/create-order", {}, { timeoutMs: 60 });
  assert.strictEqual(calls, 0); assert.strictEqual(r.offline, true);
  assert.strictEqual(ctx.CoyoteCoastal.networkFailureKind(r), "offline");
});

test("dropped connection (fetch rejects) -> network; server answers are not network failures", async () => {
  const ctx = sandbox(() => Promise.reject(new TypeError("Failed to fetch")));
  const r = await ctx.CoyoteAPI.post("/api/create-order", {}, { timeoutMs: 1000 });
  assert.strictEqual(ctx.CoyoteCoastal.networkFailureKind(r), "network");
  const ok = sandbox(() => Promise.resolve(jsonRes(409, { code: "already_paid", error: "paid" })));
  const r2 = await ok.CoyoteAPI.post("/api/create-payment-intent", {}, { timeoutMs: 1000 });
  assert.strictEqual(ok.CoyoteCoastal.networkFailureKind(r2), null);
  assert.strictEqual(r2.data.code, "already_paid");
});

test("a fast answer clears the timer (no late abort)", async () => {
  let sig = null;
  const ctx = sandbox((u, c) => { sig = c.signal; return Promise.resolve(jsonRes(201, { success: true })); });
  const r = await ctx.CoyoteAPI.post("/api/create-order", {}, { timeoutMs: 30 });
  assert.strictEqual(r.ok, true);
  await new Promise((res) => setTimeout(res, 60));
  assert.strictEqual(sig.aborted, false);
});

test("same idempotency key + identical body on retry (two sends of the frozen payload)", async () => {
  const bodies = [];
  let n = 0;
  const ctx = sandbox((u, c) => { bodies.push(c.body); n++; return n === 1 ? hang()(u, c) : Promise.resolve(jsonRes(200, { success: true, replayed: true, orderNumber: "CDD-1" })); });
  const payload = { idempotency_key: "k-123", pickup_city: "Port Aransas" }; // order.js attemptPayload() returns this same object on retry
  const first = await ctx.CoyoteAPI.post("/api/create-order", payload, { timeoutMs: 40 });
  assert.strictEqual(first.timedOut, true);
  const second = await ctx.CoyoteAPI.post("/api/create-order", payload, { timeoutMs: 40 });
  assert.strictEqual(second.ok, true);
  assert.strictEqual(bodies.length, 2);
  assert.strictEqual(bodies[0], bodies[1]);
  assert.strictEqual(JSON.parse(bodies[1]).idempotency_key, "k-123");
});

test("messages: Retry wording, no double-order / double-charge scare", () => {
  const C = require(path.join(root, "frontend/js/coastal.js"));
  assert(/may already have gone through.*Retry.*without placing a second order/.test(C.orderNetworkMessage("timeout")));
  assert(/offline.*Retry/i.test(C.orderNetworkMessage("offline")));
  assert(/Retry/.test(C.orderNetworkMessage("network")) && /won't place a second order/.test(C.orderNetworkMessage("network")));
  ["timeout", "network"].forEach((k) => assert(/already paid before charging/.test(C.paymentNetworkMessage(k))));
  assert.strictEqual(C.orderErrorMessage({ ok: false, status: 0, timedOut: true }), C.orderNetworkMessage("timeout"));
  assert.strictEqual(C.DEFAULT_TIMEOUT_MS, 15000);
});

test("wiring: order + payment use the timeout, Retry re-enters the guarded submit, confirmCardPayment not retried", () => {
  const order = read("frontend/js/order.js");
  assert(/CoyoteAPI\.post\('\/api\/create-order', attemptPayload\(orderData\),\s*\{ timeoutMs:/.test(order));
  assert(/retryBtn\.addEventListener\('click', \(\) => submitOrder\(/.test(order), "Retry goes through submitOrder (same key/payload, submitting guard)");
  assert(/if \(submitting\) return;/.test(order));
  assert(/if \(retryBtn\) retryBtn\.disabled = true;/.test(order), "Retry disabled while in flight");
  const html = read("frontend/order/index.html");
  assert(/id="orderRetryBtn" hidden/.test(html) && /id="orderSubmitStatus" role="status" aria-live="polite"/.test(html));
  const pay = read("frontend/js/stripe-payment.js");
  assert(/CoyoteAPI\.post\('\/api\/create-payment-intent', \{[\s\S]*?\}, \{ timeoutMs:/.test(pay));
  assert(/retry\.addEventListener\('click', handlePaymentSubmit\)/.test(pay), "payment Retry restarts at create-payment-intent");
  assert.strictEqual((pay.match(/await stripe\.confirmCardPayment\(/g) || []).length, 1, "single confirmCardPayment call site");
  assert(/if \(paying\) return;/.test(pay));
  assert(/id="paymentError" role="alert"/.test(pay) && /id="paymentStatusLive" role="status" aria-live="polite"/.test(pay));
});

(async () => {
  let failed = 0;
  for (const [n, f] of tests) { try { await f(); console.log("ok - " + n); } catch (e) { failed++; console.error("not ok - " + n + "\n  " + e.message); } }
  if (failed) { console.error(failed + " failed"); process.exit(1); }
  console.log("timeout-retry tests passed");
})();
