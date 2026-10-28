#!/usr/bin/env node
/**
 * POST get-orders (order number + phone → tracking token) is rate limited per
 * IP: 10 failed lookups in 15 min block further lookups (phone guessing),
 * a success doesn't reset that, token polling (GET) is never limited, and a
 * missing limiter table fails open. Stubbed Supabase, no network.
 */
"use strict";
const assert = require("assert");
const path = require("path");
const Module = require("module");
const jwt = require("jsonwebtoken");
const { createFakeSupabase } = require("./helpers/fake-supabase");

process.env.SUPABASE_URL = "http://example.invalid";
process.env.SUPABASE_SERVICE_KEY = "test";
process.env.JWT_SECRET = "test-secret-at-least-16";
let fake = null;
const realLoad = Module._load;
Module._load = function (request) {
  if (request === "@supabase/supabase-js") return { createClient: () => fake };
  return realLoad.apply(this, arguments);
};
const h = require(path.join(__dirname, "..", "netlify/functions/get-orders.js")).handler;

const fresh = () => createFakeSupabase({
  customers: [{ id: "c1", first_name: "Ana", last_name: "Cruz", phone: "3615550100" }],
  orders: [{ id: "o1", order_number: "CDD-ABC", customer_id: "c1", status: "pending", customer: { phone: "3615550100" } }],
  order_status_logs: [], admin_login_attempts: [],
});
const IP = "203.0.113.7";
const lookup = (phone, ip, num) => h({ httpMethod: "POST", headers: { "x-nf-client-connection-ip": ip || IP }, body: JSON.stringify({ order_number: num || "CDD-ABC", phone }) });
const quiet = async (f) => { const w = console.warn, e = console.error; console.warn = console.error = () => {}; try { return await f(); } finally { console.warn = w; console.error = e; } };

const tests = [];
const test = (n, f) => tests.push([n, f]);

test("10 wrong phones → the 11th lookup (even the right phone) gets 429 with Retry-After", async () => {
  fake = fresh();
  for (let i = 0; i < 10; i++) assert.strictEqual((await lookup("36155509" + String(i).padStart(2, "0"))).statusCode, 404);
  const r = await lookup("3615550100");
  assert.strictEqual(r.statusCode, 429);
  assert.ok(Number(r.headers["Retry-After"]) > 0);
  assert.strictEqual(JSON.parse(r.body).error, "Too many requests. Please wait a few minutes and try again.");
  assert.strictEqual((await lookup("3615550100", "198.51.100.9")).statusCode, 200, "other IP unaffected");
});

test("unknown order numbers count as failures too", async () => {
  fake = fresh();
  for (let i = 0; i < 10; i++) assert.strictEqual((await lookup("3615550100", IP, "CDD-NOPE" + i)).statusCode, 404);
  assert.strictEqual((await lookup("3615550100")).statusCode, 429);
});

test("a customer who mistypes a few times, then gets it right, is fine; success doesn't reset the fail count", async () => {
  fake = fresh();
  for (let i = 0; i < 3; i++) await lookup("3615550199");
  for (let i = 0; i < 5; i++) assert.strictEqual((await lookup("3615550100")).statusCode, 200);
  for (let i = 0; i < 7; i++) await lookup("3615550199");
  assert.strictEqual((await lookup("3615550100")).statusCode, 429);
});

test("polling with a valid token is never limited, even from a blocked IP", async () => {
  fake = fresh();
  for (let i = 0; i < 12; i++) await lookup("3615550199");
  const token = jwt.sign({ role: "customer", order_id: "o1" }, process.env.JWT_SECRET, { expiresIn: "1h" });
  for (let i = 0; i < 100; i++) {
    const r = await h({ httpMethod: "GET", headers: { authorization: "Bearer " + token, "x-nf-client-connection-ip": IP }, queryStringParameters: { id: "o1" } });
    assert.notStrictEqual(r.statusCode, 429);
  }
});

test("limiter table missing → fails open", async () => {
  const db = fresh();
  const err = () => { const res = Promise.resolve({ data: null, error: { code: "PGRST205", message: "Could not find the table" } }); const p = new Proxy(function () {}, { get: (_, k) => (k === "then" ? res.then.bind(res) : () => p), apply: () => p }); return p; };
  fake = Object.assign({}, db, { from: (n) => (n === "admin_login_attempts" ? err() : db.from(n)) });
  await quiet(async () => {
    for (let i = 0; i < 20; i++) assert.strictEqual((await lookup("3615550199")).statusCode, 404);
    assert.strictEqual((await lookup("3615550100")).statusCode, 200);
  });
});

(async () => {
  let failed = 0;
  for (const [n, f] of tests) {
    try { await f(); console.log("  ok  " + n); } catch (e) { failed++; console.log("  FAIL " + n + "\n    " + String(e.message || e).split("\n")[0]); }
  }
  if (failed) { console.log(failed + " failed"); process.exit(1); }
})();
