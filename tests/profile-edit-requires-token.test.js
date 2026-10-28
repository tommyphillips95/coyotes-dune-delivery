#!/usr/bin/env node
/**
 * update-application: a driver profile edit needs a valid driver login token
 * whose driver_id matches the application. Applicant ID + email is not
 * enough. An admin token can still edit any application. Fake Supabase.
 */
const assert = require("assert");
const path = require("path");
const Module = require("module");
const jwt = require("jsonwebtoken");
const { createFakeSupabase } = require("./helpers/fake-supabase");

process.env.JWT_SECRET = "profile-edit-token-secret-32chars!!";
let fake = null;
const realLoad = Module._load;
Module._load = function (request) {
  if (request === "@supabase/supabase-js") return { createClient: () => fake };
  return realLoad.apply(this, arguments);
};
const handler = require(path.join(__dirname, "..", "netlify/functions/update-application.js")).handler;
const sign = (c, secret) => jwt.sign(c, secret || process.env.JWT_SECRET, { expiresIn: "1h" });
function seed() {
  fake = createFakeSupabase({ applications: [
    { id: "a1", email: "val@example.com", status: "approved", phone: "+13615550100", first_name: "Val" },
    { id: "a2", email: "kim@example.com", status: "approved", phone: "+13615550200", first_name: "Kim" },
    { id: "p1", email: "pat@example.com", status: "pending", phone: "+13615550300", first_name: "Pat" },
  ] });
}
const put = (id, token, body) => handler({
  httpMethod: "PUT", path: "/api/update-application/" + id, queryStringParameters: { applicantId: id },
  headers: token ? { authorization: "Bearer " + token } : {},
  body: JSON.stringify(Object.assign({ phone: "+13615559999" }, body)),
});
const phone = (id) => fake.db.applications.find((a) => a.id === id).phone;
const tests = [];
const test = (n, f) => tests.push([n, f]);

test("applicant ID + correct email but no token → 401, nothing written", async () => {
  seed();
  const r = await put("a1", null, { email: "val@example.com" });
  assert.strictEqual(r.statusCode, 401, r.body);
  assert.strictEqual(phone("a1"), "+13615550100");
});
test("another driver's valid token → 403, nothing written", async () => {
  seed();
  const r = await put("a1", sign({ role: "driver", driver_id: "a2" }), { email: "val@example.com" });
  assert.strictEqual(r.statusCode, 403, r.body);
  assert.strictEqual(phone("a1"), "+13615550100");
});
test("forged or expired token → 401", async () => {
  seed();
  assert.strictEqual((await put("a1", sign({ role: "driver", driver_id: "a1" }, "wrong-secret-wrong-secret-wrong!!"))).statusCode, 401);
  assert.strictEqual((await put("a1", jwt.sign({ role: "driver", driver_id: "a1", exp: 1 }, process.env.JWT_SECRET))).statusCode, 401);
  assert.strictEqual(phone("a1"), "+13615550100");
});
test("customer/tracking token → 403", async () => {
  seed();
  const r = await put("a1", sign({ role: "customer", order_id: "o1" }));
  assert.ok([401, 403].includes(r.statusCode), r.body);
  assert.strictEqual(phone("a1"), "+13615550100");
});
test("own driver token saves (email not needed) and the response is trimmed", async () => {
  seed();
  const r = await put("a1", sign({ role: "driver", driver_id: "a1" }));
  assert.strictEqual(r.statusCode, 200, r.body);
  assert.strictEqual(phone("a1"), "+13615559999");
  assert.strictEqual(JSON.parse(r.body).data.insurance_policy_number, undefined);
});
test("own token, but no longer approved → 403", async () => {
  seed();
  const r = await put("p1", sign({ role: "driver", driver_id: "p1" }));
  assert.strictEqual(r.statusCode, 403);
  assert.strictEqual(phone("p1"), "+13615550300");
});
test("admin token can edit any application, including a pending one", async () => {
  seed();
  assert.strictEqual((await put("a2", sign({ role: "admin", user: "ops" }))).statusCode, 200);
  assert.strictEqual(phone("a2"), "+13615559999");
  assert.strictEqual((await put("p1", sign({ role: "admin", user: "ops" }))).statusCode, 200);
  assert.strictEqual(phone("p1"), "+13615559999");
});

(async () => {
  let failed = 0;
  console.log("profile-edit-requires-token.test.js");
  for (const [n, f] of tests) {
    try { await f(); console.log("  ok - " + n); }
    catch (e) { failed++; console.error("  FAIL - " + n + "\n    " + String(e.message || e).split("\n")[0]); }
  }
  Module._load = realLoad;
  if (failed) { console.error(`profile-edit-requires-token: ${failed} failed`); process.exit(1); }
  console.log(`profile-edit-requires-token: ${tests.length} passed`);
})();
