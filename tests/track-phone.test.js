#!/usr/bin/env node
/**
 * Track-order lookup (POST /api/get-orders { order_number, phone }) matches the
 * phone by digits. The order form stores the phone exactly as typed (its
 * placeholder is "(361) 555-1234"), so a customer who tracks with
 * "3615550100" or "+1 361-555-0100" must still find their order. A wrong
 * number, or another customer's order, must still be refused. No network.
 */
"use strict";
const assert = require("assert");
const path = require("path");
const Module = require("module");
const { createFakeSupabase } = require("./helpers/fake-supabase");

process.env.JWT_SECRET = "test-track-phone-secret-32-bytes!!";
process.env.SUPABASE_URL = "https://fake.supabase.test";
process.env.SUPABASE_SERVICE_KEY = "fake-service-key";

let fake = null;
const realLoad = Module._load;
Module._load = function (request) {
  if (request === "@supabase/supabase-js") return { createClient: () => fake };
  return realLoad.apply(this, arguments);
};

const getOrders = require(path.join(__dirname, "..", "netlify/functions/get-orders.js"));
const { phoneKey, samePhone } = getOrders._phone;

const seed = () => createFakeSupabase({
  orders: [
    { id: "ord-a", order_number: "CDD-AAA111", status: "pending", customer: { phone: "(361) 555-0100" } },
    { id: "ord-b", order_number: "CDD-BBB222", status: "pending", customer: { phone: "361-555-0199" } },
  ],
});
const mint = (order_number, phone) => getOrders.handler({
  httpMethod: "POST", headers: {}, body: JSON.stringify({ order_number, phone }),
});

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test("phoneKey ignores punctuation, spaces and a leading US +1", () => {
  for (const v of ["(361) 555-0100", "361-555-0100", "361.555.0100", "3615550100", "+1 (361) 555-0100", "1-361-555-0100", " 361 555 0100 "]) {
    assert.strictEqual(phoneKey(v), "3615550100", v);
  }
  assert.strictEqual(phoneKey(null), "");
});

test("samePhone needs a full number, not a fragment", () => {
  assert.ok(samePhone("(361) 555-0100", "+13615550100"));
  assert.ok(!samePhone("(361) 555-0100", "555-0100"), "7 digits is not enough");
  assert.ok(!samePhone("(361) 555-0100", "0100"));
  assert.ok(!samePhone("", ""));
  assert.ok(!samePhone("(361) 555-0100", "(361) 555-0101"));
});

test("order stored as '(361) 555-0100' is found with any common format", async () => {
  for (const typed of ["3615550100", "361-555-0100", "+1 361-555-0100", "(361) 555-0100"]) {
    fake = seed();
    const res = await mint("cdd-aaa111", typed);
    assert.strictEqual(res.statusCode, 200, typed);
    const out = JSON.parse(res.body);
    assert.strictEqual(out.orderId, "ord-a", typed);
    assert.ok(out.token, typed);
  }
});

test("the minted token only opens that customer's own order", async () => {
  fake = seed();
  const { token } = JSON.parse((await mint("CDD-AAA111", "3615550100")).body);
  const res = await getOrders.handler({
    httpMethod: "GET", headers: { authorization: "Bearer " + token },
    path: "/api/get-orders", queryStringParameters: { order_number: "CDD-BBB222" },
  });
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(JSON.parse(res.body).data.id, "ord-a", "client filters cannot widen a customer token");
});

test("wrong phone, partial phone or someone else's order is still 'Order not found'", async () => {
  fake = seed();
  for (const [num, phone] of [["CDD-AAA111", "3615550101"], ["CDD-AAA111", "555-0100"], ["CDD-BBB222", "3615550100"], ["CDD-ZZZ999", "3615550100"]]) {
    const res = await mint(num, phone);
    assert.strictEqual(res.statusCode, 404, num + " / " + phone);
    assert.strictEqual(JSON.parse(res.body).error, "Order not found");
  }
});

test("phoneVariants covers the common typed formats of one number", () => {
  const { phoneVariants } = require(path.join(__dirname, "..", "netlify/functions/_phone.js"));
  const v = phoneVariants("+1 (361) 555-0100");
  for (const f of ["3615550100", "(361) 555-0100", "361-555-0100", "361.555.0100", "+13615550100", "+1 361-555-0100", "+1 (361) 555-0100"]) assert.ok(v.includes(f), f);
  assert.ok(v.every((x) => phoneKey(x) === "3615550100"));
  assert.deepStrictEqual(phoneVariants("555-0100"), ["555-0100"], "short input: exact only");
});

test("draft schema/customer_phone_normalize.sql is re-runnable and never merges/deletes automatically", () => {
  const fs = require("fs");
  const root = path.join(__dirname, "..");
  const sql = fs.readFileSync(path.join(root, "schema/customer_phone_normalize.sql"), "utf8");
  const live = sql.split("\n").filter((l) => !/^\s*--/.test(l)).join("\n");
  assert.ok(/NOT YET RUN ANYWHERE LIVE/.test(sql));
  assert.ok(/ADD COLUMN IF NOT EXISTS phone_normalized TEXT/.test(live));
  assert.ok(/CREATE INDEX IF NOT EXISTS idx_customers_phone_normalized/.test(live));
  assert.ok(/DROP TRIGGER IF EXISTS customers_phone_normalized_sync/.test(live));
  assert.ok(!/\bDELETE\b/i.test(live), "no live DELETE");
  assert.ok(!/UPDATE\s+orders/i.test(live), "orders are never re-pointed automatically");
  assert.ok(!/DROP\s+(TABLE|COLUMN)/i.test(live), "nothing dropped");
  // Unique index only inside the duplicate-check DO block.
  const doBlock = live.slice(live.indexOf("DO $$"), live.indexOf("END $$;", live.indexOf("DO $$")));
  assert.ok(/IF dup_numbers = 0 THEN\s+CREATE UNIQUE INDEX IF NOT EXISTS customers_phone_normalized_uidx/.test(doBlock));
  assert.strictEqual((live.match(/CREATE UNIQUE INDEX/g) || []).length, 1);
  assert.ok(/ON DELETE CASCADE/.test(sql), "warns that deleting customers cascades to orders");
  const md = fs.readFileSync(path.join(root, "LAUNCH.md"), "utf8");
  assert.ok(/Optional, NOT yet run anywhere\)\* `schema\/customer_phone_normalize\.sql`/.test(md));
});

(async () => {
  let failed = 0;
  for (const [name, fn] of tests) {
    try { await fn(); console.log("ok -", name); }
    catch (e) { failed++; console.error("not ok -", name, "\n ", e.message); }
  }
  console.log(`\ntrack-phone: ${tests.length - failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
