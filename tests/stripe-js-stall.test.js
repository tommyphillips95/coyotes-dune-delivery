#!/usr/bin/env node
// Stripe.js that never loads (no onload, no onerror) must not leave checkout
// stuck on "Placing Order...": loadStripeJs gives up after the request
// timeout so afterOrderCreated falls back to the confirmation.
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const sp = fs.readFileSync(path.join(__dirname, "..", "frontend/js/stripe-payment.js"), "utf8");
const start = sp.indexOf("const STRIPE_JS_URL");
const end = sp.indexOf("// Warm it up", start);
assert.ok(start > -1 && end > start, "loadStripeJs block found");

function load(opts) {
  const timers = [];
  const scripts = [];
  const ctx = {
    window: { CoyoteCoastal: { requestTimeoutMs: () => 15000 } },
    document: { createElement: () => { const s = {}; scripts.push(s); return s; }, head: { appendChild() {} } },
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimeout: (id) => { if (timers[id - 1]) timers[id - 1].cleared = true; },
    Promise,
  };
  if (opts && opts.stripe) ctx.Stripe = function () {};
  vm.createContext(ctx);
  vm.runInContext(sp.slice(start, end) + "\nthis.loadStripeJs = loadStripeJs;", ctx);
  return { ctx, timers, scripts };
}
const tests = [];
const test = (n, f) => tests.push([n, f]);

test("stalled Stripe.js resolves false after the request timeout", async () => {
  const t = load();
  let result = "pending";
  t.ctx.loadStripeJs().then((v) => { result = v; });
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(result, "pending");
  const timer = t.timers.find((x) => !x.cleared);
  assert.ok(timer, "a timeout is armed");
  assert.strictEqual(timer.ms, 15000);
  timer.fn();
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(result, false);
});

test("after a stall the next call tries again (new script tag)", async () => {
  const t = load();
  t.ctx.loadStripeJs();
  t.timers[0].fn();
  await new Promise((r) => setImmediate(r));
  t.ctx.loadStripeJs();
  assert.strictEqual(t.scripts.length, 2);
});

test("normal load still resolves true and clears the timeout", async () => {
  const t = load();
  const p = t.ctx.loadStripeJs();
  t.ctx.Stripe = function () {};
  t.scripts[0].onload();
  assert.strictEqual(await p, true);
  assert.ok(t.timers[0].cleared);
});

test("load error still resolves false", async () => {
  const t = load();
  const p = t.ctx.loadStripeJs();
  t.scripts[0].onerror();
  assert.strictEqual(await p, false);
});

(async () => {
  let failed = 0;
  for (const [n, f] of tests) {
    try { await f(); console.log("ok - " + n); } catch (e) { failed++; console.log("not ok - " + n + "\n  " + e.message); }
  }
  console.log(`${tests.length - failed}/${tests.length} passed`);
  process.exit(failed ? 1 : 0);
})();
