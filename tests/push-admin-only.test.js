#!/usr/bin/env node
/**
 * send-push-notification used to accept unauthenticated requests, so anyone
 * could push any title, body or link to any device token or topic. It is now
 * admin only. Firebase and Supabase are stubbed, so nothing is sent.
 */
const assert = require("assert");
const path = require("path");
const Module = require("module");
const jwt = require("jsonwebtoken");
const { createFakeSupabase } = require("./helpers/fake-supabase");

process.env.JWT_SECRET = process.env.JWT_SECRET || "push-admin-only-test-secret-32chars!";
process.env.FIREBASE_ADMIN_SDK_JSON = JSON.stringify({ project_id: "x" });
const sent = [];
const fakeAdmin = {
  initializeApp() {}, credential: { cert: (x) => x },
  messaging: () => ({ send: async (m) => { sent.push(m); return "msg-1"; } }),
};
const realLoad = Module._load;
Module._load = function (request) {
  if (request === "firebase-admin") return fakeAdmin;
  if (request === "@supabase/supabase-js") return { createClient: () => createFakeSupabase({}) };
  return realLoad.apply(this, arguments);
};
const push = require(path.join(__dirname, "..", "netlify/functions/send-push-notification.js"));
const body = JSON.stringify({ topic: "drivers", title: "Urgent", body: "Re-enter your bank details at evil.example" });
const bearer = (claims) => ({ authorization: "Bearer " + jwt.sign(claims, process.env.JWT_SECRET, { expiresIn: "5m" }) });
const call = (headers) => push.handler({ httpMethod: "POST", headers, body });
const tests = [];
const test = (n, f) => tests.push([n, f]);

test("no token → 401, nothing pushed", async () => {
  sent.length = 0;
  assert.strictEqual((await call({})).statusCode, 401);
  assert.strictEqual(sent.length, 0);
});

test("driver or customer token → 403, nothing pushed", async () => {
  sent.length = 0;
  assert.strictEqual((await call(bearer({ role: "driver", driver_id: "d1" }))).statusCode, 403);
  assert.strictEqual((await call(bearer({ role: "customer", order_id: "o1" }))).statusCode, 403);
  assert.strictEqual(sent.length, 0);
});

test("admin token → sent", async () => {
  sent.length = 0;
  const r = await call(bearer({ role: "admin", email: "a@x" }));
  assert.strictEqual(r.statusCode, 200);
  assert.strictEqual(sent.length, 1);
});

(async () => {
  let failed = 0;
  console.log("push-admin-only.test.js");
  for (const [n, f] of tests) {
    try { await f(); console.log("  ok - " + n); }
    catch (e) { failed++; console.error("  FAIL - " + n + "\n    " + (e.stack || e.message)); }
  }
  Module._load = realLoad;
  if (failed) { console.error(`push-admin-only: ${failed} failed`); process.exit(1); }
  console.log(`push-admin-only: ${tests.length} passed`);
})();
