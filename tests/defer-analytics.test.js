#!/usr/bin/env node
// analytics.js / firebase-analytics.js must not block rendering: every page
// loads them with `defer` (or async), and an inline stub queues trackEvent()
// & co. until they load, then the real scripts replay the queue.
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const ROOT = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
const PAGES = ["frontend/index.html", "frontend/order/index.html", "frontend/apply/index.html",
  "frontend/driver/index.html", "frontend/admin/index.html", "frontend/admin/analytics.html"];
const tests = [];
const test = (n, f) => tests.push([n, f]);

for (const p of PAGES) {
  test(`${p}: analytics scripts are not render-blocking`, () => {
    const html = read(p);
    const tags = html.match(/<script\b[^>]*src="[^"]*(?:firebase-)?analytics\.js"[^>]*>/g) || [];
    assert.strictEqual(tags.length, 2, tags.join("\n"));
    for (const t of tags) assert(/\b(defer|async)\b/.test(t), `blocking: ${t}`);
    assert(/__cddAnalyticsQueue/.test(html), "missing pre-load queue stub");
  });
}

function pageSandbox(html) {
  const appended = [];
  const document = { readyState: "interactive", head: { appendChild: (n) => appended.push(n) },
    createElement: () => ({ style: {} }), getElementById: () => null, querySelector: () => null, addEventListener() {} };
  const m = new Map();
  const win = { document, sessionStorage: { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v) }, navigator: {} };
  win.window = win;
  const beacons = [];
  win.navigator.sendBeacon = (u, b) => { beacons.push(JSON.parse(b)); return true; };
  const ctx = vm.createContext(Object.assign(win, { console: { log() {}, warn() {} }, Date, Math, JSON, setTimeout }));
  const inline = html.match(/<script>([\s\S]*?__cddAnalyticsQueue[\s\S]*?)<\/script>/)[1];
  vm.runInContext(inline, ctx);
  return { ctx, beacons };
}

test("calls made before the deferred scripts load are queued, then replayed", () => {
  const s = pageSandbox(read("frontend/order/index.html"));
  assert.strictEqual(typeof s.ctx.trackEvent, "function");
  s.ctx.trackEvent("order", "submitted", "ride", 25); // safe no-op before load
  s.ctx.logAnalyticsEvent("order_submitted", { category: "order" });
  s.ctx.firebaseTrackEvent("x", {});
  assert.strictEqual(s.beacons.length, 0);
  vm.runInContext(read("frontend/js/analytics.js"), s.ctx);
  vm.runInContext(read("frontend/js/firebase-analytics.js"), s.ctx);
  assert.strictEqual(JSON.stringify(s.beacons.map((b) => b.event_name)), "[\"order_submitted\"]");
  assert.strictEqual(s.ctx.__cddAnalyticsQueue.length, 0);
  // After load the real functions are in place.
  s.ctx.logAnalyticsEvent("later", {});
  assert.strictEqual(s.beacons.length, 2);
});

let failed = 0;
for (const [n, f] of tests) { try { f(); console.log("  ok  " + n); } catch (e) { failed++; console.log("  FAIL " + n + "\n    " + e.message); } }
console.log(`${tests.length - failed}/${tests.length} defer-analytics tests passed`);
if (failed) process.exit(1);
