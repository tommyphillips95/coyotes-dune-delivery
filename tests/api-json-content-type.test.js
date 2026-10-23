#!/usr/bin/env node
// Function responses without Content-Type must still reach callers as objects:
//  - _cors.headers() declares application/json (overridable)
//  - CoyoteAPI parses JSON-looking text bodies; plain text stays text
//  - create-order's real response is labelled JSON
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

const tests = [];
const test = (n, f) => tests.push([n, f]);

test("CoyoteAPI: JSON body with no Content-Type is parsed (create-order orderId reachable)", async () => {
  const body = JSON.stringify({ success: true, data: { orderId: "o1", orderNumber: "CDD-1", estimatedPrice: 30 } });
  const ctx = sandbox(() => Promise.resolve(res(201, null, body)));
  const r = await ctx.CoyoteAPI.post("/api/create-order", {});
  assert.strictEqual(r.ok, true);
  assert.strictEqual(typeof r.data, "object");
  assert.strictEqual(r.data.data.orderId, "o1");
  assert.strictEqual(r.data.data.estimatedPrice, 30);
});

test("CoyoteAPI: text/plain JSON error keeps message and code", async () => {
  const ctx = sandbox(() => Promise.resolve(res(409, "text/plain; charset=utf-8", '{"code":"already_paid","error":"Already paid"}')));
  const r = await ctx.CoyoteAPI.post("/api/create-payment-intent", {});
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error, "Already paid");
  assert.strictEqual(r.data.code, "already_paid");
});

test("CoyoteAPI: non-JSON text stays text", async () => {
  const ctx = sandbox(() => Promise.resolve(res(200, "text/plain", "hello {")));
  const r = await ctx.CoyoteAPI.get("/api/x");
  assert.strictEqual(r.data, "hello {");
  const ctx2 = sandbox(() => Promise.resolve(res(200, "", "{not json")));
  const r2 = await ctx2.CoyoteAPI.get("/api/x");
  assert.strictEqual(r2.data, "{not json");
});

test("_cors.headers() declares application/json and extra can override", () => {
  delete require.cache[require.resolve("../netlify/functions/_cors")];
  const { headers } = require("../netlify/functions/_cors");
  const h = headers({ headers: {} });
  assert.strictEqual(h["Content-Type"], "application/json");
  assert(h["Access-Control-Allow-Origin"]);
  assert.strictEqual(headers({ headers: {} }, { "Content-Type": "text/csv" })["Content-Type"], "text/csv");
});

(async () => {
  let failed = 0;
  for (const [n, f] of tests) {
    try { await f(); console.log("ok - " + n); } catch (e) { failed++; console.log("not ok - " + n + "\n  " + (e && e.stack || e)); }
  }
  if (failed) process.exit(1);
})();
