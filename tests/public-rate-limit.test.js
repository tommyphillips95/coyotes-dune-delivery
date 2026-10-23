#!/usr/bin/env node
/**
 * Public write endpoints are rate limited per IP (rl:<endpoint>:<ip> rows in
 * admin_login_attempts), generously, never counting idempotent checkout
 * retries, and failing open when the table is missing. Stubbed Supabase.
 */
"use strict";
const assert = require("assert");
const path = require("path");
const Module = require("module");
const { createFakeSupabase } = require("./helpers/fake-supabase");

for (const k of ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_PHONE_NUMBER", "WEATHER_SHUTDOWN", "COYOTE_WEATHER_HOLD"]) delete process.env[k];
process.env.SUPABASE_URL = "http://example.invalid";
process.env.SUPABASE_SERVICE_KEY = "test";
process.env.SITE_ORIGIN = "https://coyote-dune-delivery.netlify.app";
process.env.JWT_SECRET = "test-secret-at-least-16";

let fake = null;
const realLoad = Module._load;
Module._load = function (request) {
  if (request === "@supabase/supabase-js") return { createClient: () => fake };
  return realLoad.apply(this, arguments);
};
const FN = path.join(__dirname, "..", "netlify/functions");
const createOrder = require(path.join(FN, "create-order.js"));
const analytics = require(path.join(FN, "log-analytics-event.js"));
const submitApp = require(path.join(FN, "submit-application.js"));

const freshDb = () => createFakeSupabase({ customers: [], orders: [], order_status_logs: [], sms_logs: [], admin_login_attempts: [], analytics_events: [], applications: [] });
function missingTable(db) {
  const errChain = () => {
    const res = Promise.resolve({ data: null, error: { code: "PGRST205", message: "Could not find the table 'public.admin_login_attempts'" } });
    const p = new Proxy(function () {}, { get: (_, k) => (k === "then" ? res.then.bind(res) : () => p), apply: () => p });
    return p;
  };
  return Object.assign({}, db, { from: (n) => (n === "admin_login_attempts" ? errChain() : db.from(n)) });
}
const order = (i) => ({
  first_name: "Test", last_name: "Customer", phone: "36155501" + String(i % 100).padStart(2, "0"),
  pickup_address: "1 Beach Access Rd", pickup_city: "Port Aransas", pickup_zip: "78373",
  dropoff_address: "Pin 12", dropoff_city: "Mustang Island", dropoff_zip: "78373",
  service_type: "ride", passenger_count: 1,
});
const hdr = (ip) => ({ origin: process.env.SITE_ORIGIN, "x-nf-client-connection-ip": ip || "203.0.113.7" });
const postOrder = (b, ip) => createOrder.handler({ httpMethod: "POST", headers: hdr(ip), body: JSON.stringify(b) });

const tests = [];
const test = (n, f) => tests.push([n, f]);

test("create-order: 30 new orders per IP per 15 min, the 31st gets 429 with Retry-After", async () => {
  fake = freshDb();
  for (let i = 0; i < 30; i++) assert.strictEqual((await postOrder(order(i))).statusCode, 201, "order " + i);
  const r = await postOrder(order(31));
  assert.strictEqual(r.statusCode, 429);
  assert.ok(Number(r.headers["Retry-After"]) > 0);
  assert.match(JSON.parse(r.body).error, /try again/i);
  assert.strictEqual(fake.db.orders.length, 30);
  // Another IP is unaffected.
  assert.strictEqual((await postOrder(order(40), "198.51.100.9")).statusCode, 201);
});

test("create-order: idempotent retries are never counted or blocked", async () => {
  fake = freshDb();
  const b = Object.assign(order(1), { idempotency_key: "chk_abcdefghij1234567890" });
  for (let i = 0; i < 60; i++) {
    const r = await postOrder(b);
    assert.ok(r.statusCode === 201 || r.statusCode === 200, "retry " + i + " → " + r.statusCode);
  }
  assert.strictEqual(fake.db.orders.length, 1);
});

test("create-order: limiter table missing → fails open", async () => {
  fake = missingTable(freshDb());
  const ow = console.warn; console.warn = () => {};
  try { for (let i = 0; i < 35; i++) assert.strictEqual((await postOrder(order(i))).statusCode, 201); }
  finally { console.warn = ow; }
});

test("create-order: window resets after 15 minutes", async () => {
  fake = freshDb();
  for (let i = 0; i < 30; i++) await postOrder(order(i));
  fake.db.admin_login_attempts.forEach((r) => { r.first_failed_at = new Date(Date.now() - 16 * 60 * 1000).toISOString(); });
  assert.strictEqual((await postOrder(order(50))).statusCode, 201);
});

test("log-analytics-event: limited per IP (600 / 15 min)", async () => {
  fake = freshDb();
  const ev = { httpMethod: "POST", headers: hdr(), body: JSON.stringify({ event_name: "x" }) };
  for (let i = 0; i < 600; i++) assert.strictEqual((await analytics.handler(ev)).statusCode, 201);
  assert.strictEqual((await analytics.handler(ev)).statusCode, 429);
});

test("submit-application: 20 per IP per 15 min, the 21st gets 429 and saves nothing", async () => {
  fake = freshDb();
  const ok = { firstName: "J", lastName: "S", vehicleClass: "2wd", bgConsent: true, bgDisclosureRead: true, esignature: true, termsAgree: true };
  const post = (i) => submitApp.handler({ httpMethod: "POST", headers: Object.assign({ "content-type": "application/json" }, hdr()), body: JSON.stringify(Object.assign({ email: "j" + i + "@example.com" }, ok)) });
  const oe = console.error, ow = console.warn; console.error = console.warn = () => {};
  try {
    for (let i = 0; i < 20; i++) { const r = await post(i); assert.ok(r.statusCode < 300, "app " + i + " → " + r.statusCode + " " + r.body); }
    assert.strictEqual((await post(21)).statusCode, 429);
  } finally { console.error = oe; console.warn = ow; }
  assert.strictEqual(fake.db.applications.length, 20);
});

(async () => {
  let failed = 0;
  for (const [n, f] of tests) {
    try { await f(); console.log("  ok  " + n); } catch (e) { failed++; console.log("  FAIL " + n + "\n    " + String(e.message || e).split("\n")[0]); }
  }
  if (failed) { console.log(failed + " failed"); process.exit(1); }
})();
