#!/usr/bin/env node
// Order page 503s: only create-order's real weather hold says "paused";
// any other 503 is the normal try-again error. Runs the real CoyoteAPI + coastal.js.
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const root = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");

function sandbox(fetchImpl) {
  const noop = () => {};
  const document = { querySelectorAll: () => [], querySelector: () => null, getElementById: () => null, addEventListener: noop, createElement: () => ({ style: {}, setAttribute: noop, appendChild: noop, classList: { add: noop, remove: noop } }), body: { appendChild: noop } };
  const win = { document, navigator: { onLine: true }, localStorage: { getItem: () => null, setItem: noop, removeItem: noop }, addEventListener: noop, location: { pathname: "/order/", search: "" },
    fetch: fetchImpl, AbortController, setTimeout, clearTimeout, console: { error: noop, log: noop, warn: noop }, IntersectionObserver: function () { return { observe: noop }; } };
  win.window = win; win.globalThis = win;
  const ctx = vm.createContext(Object.assign(win, { Promise, Error, Object, JSON, Array, String, Number, Math, Date, URLSearchParams, FormData: function () {} }));
  vm.runInContext(read("frontend/js/coastal.js"), ctx);
  vm.runInContext(read("frontend/js/main.js"), ctx);
  return ctx;
}
const res = (status, ct, body) => ({ ok: status < 400, status, headers: { get: () => ct },
  json: async () => JSON.parse(body), text: async () => body });

const { weatherShutdownPayload } = require(path.join(root, "netlify/functions/_weather.js"));
const tests = [];
const test = (n, f) => tests.push([n, f]);
const via = async (status, ct, body) => {
  const ctx = sandbox(() => Promise.resolve(res(status, ct, body)));
  const r = await ctx.CoyoteAPI.post("/api/create-order", {});
  return ctx.CoyoteCoastal.orderErrorMessage(r);
};
const GENERIC = /Something went wrong placing your order\. Please try again/;

test("real weather hold 503 (create-order payload) shows the hold reason", async () => {
  const custom = await via(503, "application/json", JSON.stringify(weatherShutdownPayload({ WEATHER_SHUTDOWN: "1", WEATHER_SHUTDOWN_REASON: "Storm hold until Tuesday." })));
  assert.strictEqual(custom, "Storm hold until Tuesday.");
  const dflt = await via(503, "application/json", JSON.stringify(weatherShutdownPayload({ WEATHER_SHUTDOWN: "1" })));
  assert.ok(/paused for weather/i.test(dflt), dflt);
});

test("503 that isn't the weather hold is the normal try-again error, never 'paused'", async () => {
  for (const [ct, body] of [["text/html", "<html>Service Unavailable</html>"], [null, ""], ["application/json", '{"error":"db"}'], ["application/json", '{"error":"upstream connect error or disconnect/reset before headers"}'], ["text/plain", "Service Unavailable"]]) {
    const m = await via(503, ct, body);
    assert.ok(GENERIC.test(m), body + " -> " + m);
    assert.ok(!/paused/i.test(m), m);
    assert.ok(!/db|upstream|html/i.test(m), m);
  }
});

test("helper: weather_hold flag is what decides", () => {
  const C = require(path.join(root, "frontend/js/coastal.js"));
  assert.ok(GENERIC.test(C.orderErrorMessage({ ok: false, status: 503 })));
  assert.ok(GENERIC.test(C.orderErrorMessage({ ok: false, status: 503, error: "db", data: { error: "db" } })));
  assert.ok(/paused for weather/.test(C.orderErrorMessage({ ok: false, status: 503, error: "weather_hold", data: { weather_hold: true } })));
});

(async () => {
  let failed = 0;
  for (const [n, f] of tests) {
    try { await f(); console.log("ok -", n); } catch (e) { failed++; console.error("not ok -", n); console.error(e.stack || e); }
  }
  if (failed) process.exit(1);
  console.log("order-503-message: " + tests.length + " passed");
})();
