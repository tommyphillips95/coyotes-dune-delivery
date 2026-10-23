#!/usr/bin/env node
/**
 * GET /api/get-orders (the link-based lookup the track page polls). Before: a
 * database error was thrown into serverError -> raw 500 "Failed to fetch
 * orders". Now it is the same clean 503 as the POST lookup (#91) and is
 * logged. Not found stays the identical 404 { error: "Order not found" },
 * including PostgREST's "no rows" (PGRST116) from .single(). Supabase faked.
 */
"use strict";
const assert = require("assert");
const path = require("path");
const Module = require("module");
const jwt = require("jsonwebtoken");
const { createFakeSupabase } = require("./helpers/fake-supabase");

process.env.JWT_SECRET = "test-get-orders-get-secret-32-bytes";
process.env.SUPABASE_URL = "https://fake.supabase.test";
process.env.SUPABASE_SERVICE_KEY = "fake-service-key";
let fake = null;
const realLoad = Module._load;
Module._load = function (request) {
  if (request === "@supabase/supabase-js") return { createClient: () => fake };
  return realLoad.apply(this, arguments);
};
const getOrders = require(path.join(__dirname, "..", "netlify/functions/get-orders.js"));

const ORDERS = [{ id: "a", order_number: "CDD-AAA111", status: "assigned", created_at: "2026-10-01", customer: { phone: "3615550100" } }];
const NOT_FOUND_BODY = JSON.stringify({ error: "Order not found" });
const UNAVAILABLE = "Order lookup is temporarily unavailable. Please try again.";

function failWith(error) {
  const from = fake.from;
  fake.from = (name) => { const q = from(name); q.then = (res) => res({ data: null, error }); return q; };
}
async function capture(f) {
  const logged = []; const e = console.error; console.error = (...a) => logged.push(a.map(String).join(" "));
  try { return { res: await f(), logged }; } finally { console.error = e; }
}
const get = (token, qs = {}) => getOrders.handler({ httpMethod: "GET", headers: { authorization: "Bearer " + token }, path: "/api/get-orders", queryStringParameters: qs });
const customer = (order_id) => jwt.sign({ role: "customer", order_id }, process.env.JWT_SECRET, { expiresIn: "1h" });
const admin = () => jwt.sign({ role: "admin" }, process.env.JWT_SECRET, { expiresIn: "1h" });

const tests = [];
const test = (n, f) => tests.push([n, f]);

test("baseline: customer token GET returns the order", async () => {
  fake = createFakeSupabase({ orders: ORDERS });
  const res = await get(customer("a"));
  assert.strictEqual(res.statusCode, 200);
});

for (const [who, tok, qs] of [["customer", () => customer("a"), {}], ["admin by id", admin, { id: "a" }], ["admin by phone", admin, { phone: "3615550100" }]]) {
  test(`${who}: database error is a clean, logged 503 (same body as POST)`, async () => {
    fake = createFakeSupabase({ orders: ORDERS });
    failWith({ code: "08006", message: "connection refused" });
    const { res, logged } = await capture(() => get(tok(), qs));
    assert.strictEqual(res.statusCode, 503);
    assert.deepStrictEqual(JSON.parse(res.body), { error: UNAVAILABLE });
    assert.doesNotMatch(res.body, /connection refused|not found/i);
    assert(logged.some((l) => /get-orders/.test(l) && /connection refused/.test(l)), "logged: " + JSON.stringify(logged));
  });
}

test("same 503 body as the POST lookup's database error", async () => {
  fake = createFakeSupabase({ orders: ORDERS });
  failWith({ message: "timeout" });
  const { res: g } = await capture(() => get(customer("a")));
  const { res: p } = await capture(() => getOrders.handler({ httpMethod: "POST", headers: {}, body: JSON.stringify({ order_number: "CDD-AAA111", phone: "3615550100" }) }));
  assert.deepStrictEqual([g.statusCode, g.body], [p.statusCode, p.body]);
});

test("not found (empty list) is the identical 404", async () => {
  fake = createFakeSupabase({ orders: ORDERS });
  const res = await get(admin(), { phone: "3615550199" });
  assert.deepStrictEqual([res.statusCode, res.body], [404, NOT_FOUND_BODY]);
});

test("not found via .single() (PostgREST PGRST116, 0 rows) is the identical 404, not 503", async () => {
  fake = createFakeSupabase({ orders: ORDERS });
  failWith({ code: "PGRST116", details: "The result contains 0 rows", message: "JSON object requested, multiple (or no) rows returned" });
  const { res } = await capture(() => get(customer("gone")));
  assert.deepStrictEqual([res.statusCode, res.body], [404, NOT_FOUND_BODY]);
});

(async () => {
  console.log("get-orders-get-errors.test.js");
  let failed = 0;
  for (const [n, f] of tests) {
    try { await f(); console.log("ok - " + n); } catch (e) { failed++; console.log("not ok - " + n + "\n  " + (e && e.message)); }
  }
  if (failed) { console.error(`get-orders-get-errors: ${failed} failed`); process.exit(1); }
  console.log(`get-orders-get-errors: ${tests.length} passed`);
})();
