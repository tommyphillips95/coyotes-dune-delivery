#!/usr/bin/env node
/**
 * checkr-webhook must fail closed. With CHECKR_WEBHOOK_SECRET unset it used to
 * skip signature checks, so anyone could post a "clear" report and
 * auto-approve a driver application. Stubbed Supabase, no network.
 */
const assert = require("assert");
const path = require("path");
const crypto = require("crypto");
const Module = require("module");
const { createFakeSupabase } = require("./helpers/fake-supabase");

let currentFake = null;
const realLoad = Module._load;
Module._load = function (request) {
  if (request === "@supabase/supabase-js") return { createClient: () => currentFake };
  return realLoad.apply(this, arguments);
};
const FILE = path.join(__dirname, "..", "netlify/functions/checkr-webhook.js");
function load(secret) {
  if (secret) process.env.CHECKR_WEBHOOK_SECRET = secret; else delete process.env.CHECKR_WEBHOOK_SECRET;
  delete require.cache[require.resolve(FILE)];
  return require(FILE);
}
const body = JSON.stringify({ type: "report.completed", id: "ev1", data: { object: { id: "rep1", status: "clear" } } });
const seed = () => createFakeSupabase({ applications: [{ id: "a1", status: "background_check", background_check_status: "pending", background_check_report_id: "rep1" }] });
const tests = [];
const test = (n, f) => tests.push([n, f]);

test("no secret configured: forged 'clear' report → 401, driver NOT approved", async () => {
  currentFake = seed();
  const h = load(null);
  for (const headers of [{}, { "x-checkr-signature": "deadbeef" }]) {
    const r = await h.handler({ httpMethod: "POST", headers, body });
    assert.strictEqual(r.statusCode, 401);
  }
  assert.strictEqual(currentFake.db.applications[0].status, "background_check");
  assert.strictEqual(currentFake.db.applications[0].background_check_status, "pending");
});

test("secret set: bad signature → 401, unchanged", async () => {
  currentFake = seed();
  const h = load("whsec-test");
  const r = await h.handler({ httpMethod: "POST", headers: { "x-checkr-signature": "00".repeat(32) }, body });
  assert.strictEqual(r.statusCode, 401);
  assert.strictEqual(currentFake.db.applications[0].status, "background_check");
});

test("secret set: valid signature still processes the report", async () => {
  currentFake = seed();
  const h = load("whsec-test");
  const sig = crypto.createHmac("sha256", "whsec-test").update(body, "utf8").digest("hex");
  const r = await h.handler({ httpMethod: "POST", headers: { "x-checkr-signature": sig }, body });
  assert.strictEqual(r.statusCode, 200);
  assert.strictEqual(currentFake.db.applications[0].background_check_status, "clear");
});

(async () => {
  let failed = 0;
  console.log("checkr-webhook-secret.test.js");
  for (const [n, f] of tests) {
    try { await f(); console.log("  ok - " + n); }
    catch (e) { failed++; console.error("  FAIL - " + n + "\n    " + (e.stack || e.message)); }
  }
  Module._load = realLoad;
  delete process.env.CHECKR_WEBHOOK_SECRET;
  if (failed) { console.error(`checkr-webhook-secret: ${failed} failed`); process.exit(1); }
  console.log(`checkr-webhook-secret: ${tests.length} passed`);
})();
