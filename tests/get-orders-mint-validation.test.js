#!/usr/bin/env node
/**
 * POST /api/get-orders (mint tracking token) validation gaps that the
 * happy-path / rate-limit / phone-format suites don't cover: missing or
 * blank order_number/phone, invalid JSON, and that a validation 400 never
 * burns the phone-guessing fail budget. Stubbed Supabase, no network.
 */
"use strict";
const assert = require("assert");
const path = require("path");
const Module = require("module");
const { createFakeSupabase } = require("./helpers/fake-supabase");

process.env.SUPABASE_URL = "http://example.invalid";
process.env.SUPABASE_SERVICE_KEY = "test";
process.env.JWT_SECRET = "test-mint-validation-secret-32b!";

let fake = null;
const realLoad = Module._load;
Module._load = function (request) {
  if (request === "@supabase/supabase-js") return { createClient: () => fake };
  return realLoad.apply(this, arguments);
};
const h = require(path.join(__dirname, "..", "netlify/functions/get-orders.js")).handler;

const seed = () => createFakeSupabase({
  customers: [{ id: "c1", first_name: "Ana", last_name: "Cruz", phone: "3615550100" }],
  orders: [
    { id: "o1", order_number: "CDD-ABC", customer_id: "c1", status: "pending", customer: { phone: "3615550100" } },
    { id: "o2", order_number: "CDD-NOPHONE", customer_id: "c2", status: "pending", customer: { phone: null } },
  ],
  order_status_logs: [], admin_login_attempts: [],
});

const IP = "203.0.113.55";
const post = (body, ip) => h({
  httpMethod: "POST",
  headers: { "x-nf-client-connection-ip": ip || IP },
  body: typeof body === "string" ? body : JSON.stringify(body),
});

const tests = [];
const test = (n, f) => tests.push([n, f]);

test("missing order_number is 400 with a clear error; nothing looked up", async () => {
  fake = seed();
  const res = await post({ phone: "3615550100" });
  assert.strictEqual(res.statusCode, 400);
  assert.deepStrictEqual(JSON.parse(res.body), { error: "order_number and phone are required" });
});

test("missing phone is 400 with the same error", async () => {
  fake = seed();
  const res = await post({ order_number: "CDD-ABC" });
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(JSON.parse(res.body).error, "order_number and phone are required");
});

test("whitespace-only order_number or phone is 400 (trimmed empty)", async () => {
  fake = seed();
  for (const body of [
    { order_number: "   ", phone: "3615550100" },
    { order_number: "CDD-ABC", phone: " \t " },
    { order_number: "", phone: "" },
    {},
  ]) {
    const res = await post(body);
    assert.strictEqual(res.statusCode, 400, JSON.stringify(body));
    assert.strictEqual(JSON.parse(res.body).error, "order_number and phone are required");
  }
});

test("invalid JSON body is 400 'Invalid JSON', not a 500", async () => {
  fake = seed();
  const res = await post("{not-json");
  assert.strictEqual(res.statusCode, 400);
  assert.deepStrictEqual(JSON.parse(res.body), { error: "Invalid JSON" });
});

test("validation 400 does not burn the track-lookup-fail budget", async () => {
  fake = seed();
  for (let i = 0; i < 15; i++) {
    assert.strictEqual((await post({ order_number: "", phone: "" })).statusCode, 400);
  }
  const ok = await post({ order_number: "CDD-ABC", phone: "3615550100" });
  assert.strictEqual(ok.statusCode, 200, "blank submits must not lock out a real lookup");
  assert.ok(JSON.parse(ok.body).token);
});

test("order whose customer has no phone is the same 404 as not found", async () => {
  fake = seed();
  const res = await post({ order_number: "CDD-NOPHONE", phone: "3615550100" });
  assert.strictEqual(res.statusCode, 404);
  assert.strictEqual(JSON.parse(res.body).error, "Order not found");
});

(async () => {
  console.log("get-orders-mint-validation.test.js");
  let failed = 0;
  for (const [n, f] of tests) {
    try { await f(); console.log("ok - " + n); }
    catch (e) { failed++; console.log("not ok - " + n + "\n  " + (e && e.message)); }
  }
  if (failed) { console.error(`get-orders-mint-validation: ${failed} failed`); process.exit(1); }
  console.log(`get-orders-mint-validation: ${tests.length} passed`);
})();
