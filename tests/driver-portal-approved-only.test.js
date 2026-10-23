#!/usr/bin/env node
/**
 * Driver portal: only approved drivers get a login (driver JWT), everyone else
 * gets 403 pending_review and no token. Login and profile-edit responses carry
 * only the fields the page shows: no date of birth, insurance policy number,
 * documents or internal fields. A blank policy on edit keeps the one on file.
 * Stubbed Supabase, no network.
 */
const assert = require("assert");
const path = require("path");
const Module = require("module");
const { createFakeSupabase } = require("./helpers/fake-supabase");

process.env.JWT_SECRET = process.env.JWT_SECRET || "driver-portal-test-secret-32chars!!";
let fake = null;
const realLoad = Module._load;
Module._load = function (request) {
  if (request === "@supabase/supabase-js") return { createClient: () => fake };
  return realLoad.apply(this, arguments);
};
const FN = path.join(__dirname, "..", "netlify/functions");
const getStatus = require(path.join(FN, "get-status.js")).handler;
const updateApp = require(path.join(FN, "update-application.js")).handler;

const SECRET_KEYS = ["date_of_birth", "dob", "insurance_policy_number", "insurance_policy", "documents", "notes",
  "background_check_report_id", "background_check_status", "ssn_last4", "drivers_license_number"];
function app(over) {
  return Object.assign({
    id: "a1", email: "val@example.com", status: "approved", first_name: "Val", last_name: "D", phone: "+13615550100",
    address: "1 Dune Rd", city: "Port Aransas", state: "TX", zip: "78373",
    vehicle_year: 2020, vehicle_make: "Jeep", vehicle_model: "Wrangler", license_plate: "ABC123",
    insurance_provider: "Acme", insurance_policy_number: "POL-SECRET-9", date_of_birth: "1990-01-02",
    notes: "admin only", background_check_report_id: "rep1", background_check_status: "clear",
    drivers_license_number: "TX123", ssn_last4: "1234",
  }, over);
}
const seed = (over) => { fake = createFakeSupabase({ applications: [app(over)], documents: [{ id: "doc1", application_id: "a1", url: "https://files/x.pdf" }] }); };
const login = async () => { const r = await getStatus({ httpMethod: "POST", headers: {}, body: JSON.stringify({ applicantId: "a1", email: "val@example.com" }) }); return { status: r.statusCode, body: JSON.parse(r.body) }; };
const edit = async (b) => { const r = await updateApp({ httpMethod: "PUT", path: "/api/update-application/a1", queryStringParameters: { applicantId: "a1" }, headers: {}, body: JSON.stringify(Object.assign({ email: "val@example.com" }, b)) }); return { status: r.statusCode, body: JSON.parse(r.body) }; };
const noSecrets = (obj) => { for (const k of SECRET_KEYS) assert.ok(!(k in obj), `response leaks ${k}`); assert.ok(!JSON.stringify(obj).includes("POL-SECRET-9")); assert.ok(!JSON.stringify(obj).includes("1990-01-02")); };
const tests = [];
const test = (n, f) => tests.push([n, f]);

for (const st of ["pending", "background_check", "on_hold", "rejected", "suspended"]) {
  test(`login: ${st} applicant → 403 pending_review, no token, no profile`, async () => {
    seed({ status: st });
    const r = await login();
    assert.strictEqual(r.status, 403);
    assert.strictEqual(r.body.code, "pending_review");
    assert.ok(/pending review/i.test(r.body.error));
    assert.ok(!r.body.token);
    assert.deepStrictEqual(Object.keys(r.body).sort(), ["code", "error"]);
  });
}

test("login: approved driver gets a token and only the page's fields", async () => {
  seed();
  const r = await login();
  assert.strictEqual(r.status, 200);
  assert.ok(r.body.token);
  noSecrets(r.body);
  assert.strictEqual(r.body.name, "Val D");
  assert.strictEqual(r.body.vehicle_plate, "ABC123");
  assert.strictEqual(r.body.insurance_provider, "Acme");
});

test("profile edit: response is trimmed; blank policy keeps the one on file", async () => {
  seed();
  const r = await edit({ phone: "+13615550111", insurance_policy: "" });
  assert.strictEqual(r.status, 200);
  noSecrets(r.body.data);
  assert.strictEqual(r.body.data.phone, "+13615550111");
  assert.strictEqual(fake.db.applications[0].insurance_policy_number, "POL-SECRET-9");
  await edit({ insurance_policy: "POL-NEW-1" });
  assert.strictEqual(fake.db.applications[0].insurance_policy_number, "POL-NEW-1");
});

test("profile edit: non-approved applicant → 403 pending_review, nothing written", async () => {
  seed({ status: "pending" });
  const r = await edit({ phone: "+13615550111" });
  assert.strictEqual(r.status, 403);
  assert.strictEqual(r.body.code, "pending_review");
  assert.strictEqual(fake.db.applications[0].phone, "+13615550100");
});

(async () => {
  let failed = 0;
  console.log("driver-portal-approved-only.test.js");
  for (const [n, f] of tests) {
    try { await f(); console.log("  ok - " + n); }
    catch (e) { failed++; console.error("  FAIL - " + n + "\n    " + (e.message || e)); }
  }
  Module._load = realLoad;
  if (failed) { console.error(`driver-portal-approved-only: ${failed} failed`); process.exit(1); }
  console.log(`driver-portal-approved-only: ${tests.length} passed`);
})();
