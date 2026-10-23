#!/usr/bin/env node
/**
 * log-analytics-event is a public, unauthenticated write. Oversized or
 * malformed events get a 400 and store nothing; bad JSON is a 400, not a 500.
 * Normal events from the site still save. Stubbed Supabase.
 */
"use strict";
const assert = require("assert");
const path = require("path");
const Module = require("module");
const { createFakeSupabase } = require("./helpers/fake-supabase");
process.env.SUPABASE_URL = "http://example.invalid";
process.env.SUPABASE_SERVICE_KEY = "test";
let fake = null;
const realLoad = Module._load;
Module._load = function (r) { if (r === "@supabase/supabase-js") return { createClient: () => fake }; return realLoad.apply(this, arguments); };
const h = require(path.join(__dirname, "..", "netlify/functions/log-analytics-event.js")).handler;
const post = (body) => h({ httpMethod: "POST", headers: { "x-nf-client-connection-ip": "203.0.113.5" }, body: typeof body === "string" ? body : JSON.stringify(body) });
const fresh = () => createFakeSupabase({ analytics_events: [], admin_login_attempts: [] });
const tests = []; const test = (n, f) => tests.push([n, f]);

test("normal site events still save (201)", async () => {
  fake = fresh();
  for (const b of [
    { event_name: "order_submitted", category: "order", metadata: { service_type: "ride", estimated_price: 30, order_number: "CDD-X" } },
    { event_name: "application_started", metadata: { category: "application", step: 1 }, user_id: null, session_id: "sess_1_abc" },
    { event_name: "x" },
  ]) assert.strictEqual((await post(b)).statusCode, 201);
  assert.strictEqual(fake.db.analytics_events.length, 3);
});

test("oversized or malformed events → 400, nothing stored", async () => {
  fake = fresh();
  const big = "a".repeat(5000);
  const cases = [
    { event_name: "x", metadata: { blob: big } },
    { event_name: big.slice(0, 101) },
    { event_name: "x", category: big.slice(0, 51) },
    { event_name: "x", user_id: { $ne: 1 } },
    { event_name: "x", metadata: [1, 2] },
    { event_name: "x", metadata: "str" },
    JSON.stringify({ event_name: "x", pad: "b".repeat(9000) }),
    "{not json",
    "null",
    "[1]",
  ];
  for (const c of cases) {
    const r = await post(c);
    assert.strictEqual(r.statusCode, 400, JSON.stringify(c).slice(0, 60) + " → " + r.statusCode);
  }
  assert.strictEqual(fake.db.analytics_events.length, 0);
});

(async () => {
  let failed = 0;
  for (const [n, f] of tests) { try { await f(); console.log("  ok  " + n); } catch (e) { failed++; console.log("  FAIL " + n + "\n    " + String(e.message).split("\n")[0]); } }
  if (failed) { console.log(failed + " failed"); process.exit(1); }
})();
