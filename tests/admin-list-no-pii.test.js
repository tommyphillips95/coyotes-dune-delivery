#!/usr/bin/env node
/**
 * The admin applications list (GET /api/admin/applications and the legacy
 * get-applications) leaves out date of birth and insurance policy number.
 * They come only from GET /api/admin/applications/:id with an admin token,
 * and the detail modal fetches that per application. Fake Supabase.
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const Module = require("module");
const jwt = require("jsonwebtoken");
const { createFakeSupabase } = require("./helpers/fake-supabase");

process.env.JWT_SECRET = "admin-list-no-pii-secret-32chars!!";
process.env.SUPABASE_URL = "http://example.invalid";
process.env.SUPABASE_SERVICE_KEY = "test";
let fake = null;
const realLoad = Module._load;
Module._load = function (request) {
  if (request === "@supabase/supabase-js") return { createClient: () => fake };
  return realLoad.apply(this, arguments);
};
const ROOT = path.join(__dirname, "..");
const admin = require(path.join(ROOT, "netlify/functions/admin.js")).handler;
const legacy = require(path.join(ROOT, "netlify/functions/get-applications.js")).handler;
const ADMIN = jwt.sign({ role: "admin", user: "ops" }, process.env.JWT_SECRET);
const DRIVER = jwt.sign({ role: "driver", driver_id: "a1" }, process.env.JWT_SECRET);
const ev = (p, token) => ({ httpMethod: "GET", path: "/.netlify/functions/admin" + p, headers: token ? { authorization: "Bearer " + token } : {} });
const seed = () => { fake = createFakeSupabase({ applications: [
  { id: "a1", first_name: "Val", last_name: "V", email: "val@example.com", status: "approved", date_of_birth: "1990-01-02", insurance_policy_number: "POL-SECRET-9", insurance_provider: "Acme", created_at: "2026-10-01" },
] }); };
const SECRETS = /1990-01-02|POL-SECRET-9/;
const tests = [];
const test = (n, f) => tests.push([n, f]);

test("admin list has no DOB or policy number (raw or dashboard names)", async () => {
  seed();
  const r = await admin(ev("/applications", ADMIN));
  assert.strictEqual(r.statusCode, 200);
  const a = JSON.parse(r.body).applications[0];
  assert.ok(!SECRETS.test(r.body), r.body);
  for (const k of ["date_of_birth", "dob", "insurance_policy_number", "insurance_policy"]) assert.ok(!(k in a), k);
  assert.strictEqual(a.name, "Val V"); assert.strictEqual(a.insurance_provider, "Acme");
});
test("legacy get-applications list has no DOB or policy number", async () => {
  seed();
  const r = await legacy({ httpMethod: "GET", headers: { authorization: "Bearer " + ADMIN } });
  assert.strictEqual(r.statusCode, 200);
  assert.ok(!SECRETS.test(r.body), r.body);
  assert.strictEqual(JSON.parse(r.body).applications[0].email, "val@example.com");
});
test("GET /applications/:id with admin token returns DOB + policy", async () => {
  seed();
  const r = await admin(ev("/applications/a1", ADMIN));
  assert.strictEqual(r.statusCode, 200, r.body);
  const a = JSON.parse(r.body).application;
  assert.strictEqual(a.dob, "1990-01-02");
  assert.strictEqual(a.insurance_policy, "POL-SECRET-9");
});
test("detail endpoint: unknown id 404; no token 401; driver token 403", async () => {
  seed();
  assert.strictEqual((await admin(ev("/applications/nope", ADMIN))).statusCode, 404);
  assert.strictEqual((await admin(ev("/applications/a1"))).statusCode, 401);
  const r = await admin(ev("/applications/a1", DRIVER));
  assert.strictEqual(r.statusCode, 403);
  assert.ok(!SECRETS.test(r.body));
});
test("admin UI fetches the single application for the detail modal", () => {
  const src = fs.readFileSync(path.join(ROOT, "frontend/admin/admin.js"), "utf8");
  const fn = src.slice(src.indexOf("async function openDetail"), src.indexOf("function buildDetailHTML"));
  assert.match(fn, /api\('GET', `\/applications\/\$\{encodeURIComponent\(id\)\}`\)/);
});

(async () => {
  let failed = 0;
  console.log("admin-list-no-pii.test.js");
  for (const [n, f] of tests) {
    try { await f(); console.log("  ok - " + n); }
    catch (e) { failed++; console.error("  FAIL - " + n + "\n    " + String(e.message || e).split("\n")[0]); }
  }
  Module._load = realLoad;
  if (failed) { console.error(`admin-list-no-pii: ${failed} failed`); process.exit(1); }
  console.log(`admin-list-no-pii: ${tests.length} passed`);
})();
