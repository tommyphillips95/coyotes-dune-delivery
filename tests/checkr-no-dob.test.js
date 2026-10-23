#!/usr/bin/env node
// The admin Checkr page showed each candidate's date of birth, and
// GET /api/checkr/candidates(/:id) returned it for every applicant. Checkr
// does need DOB, but only server-side (createCheck sends it to Checkr's
// candidate API), so it stays there and never reaches the browser.
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const Module = require("module");
const jwt = require("jsonwebtoken");
const { createFakeSupabase } = require("./helpers/fake-supabase");

let fake = null;
const realLoad = Module._load;
Module._load = function (request) {
  if (request === "@supabase/supabase-js") return { createClient: () => fake };
  if (request === "twilio" || request === "stripe") throw new Error(request + " must not load in tests");
  return realLoad.apply(this, arguments);
};
process.env.SUPABASE_URL = "http://example.invalid";
process.env.SUPABASE_SERVICE_KEY = "test";
process.env.JWT_SECRET = "test-jwt-secret-for-checkr-dob-32b!!";
process.env.CHECKR_API_KEY = "test_checkr_key";

const ROOT = path.join(__dirname, "..");
const { handler } = require(path.join(ROOT, "netlify/functions/checkr.js"));
const DOB = "1987-06-05";
const seed = () => wrap(createFakeSupabase({
  applications: [{ id: "app-1", first_name: "Val", last_name: "D", email: "val@example.com", zip_code: "78373", status: "pending", date_of_birth: DOB, background_check_consent: true, created_at: "2026-10-01" }],
  background_check_logs: [],
}));
// checkr.js inserts a single object (supabase-js accepts both); the shared fake wants an array.
function wrap(f) {
  const from = f.from.bind(f);
  f.from = (t) => { const b = from(t); const ins = b.insert; b.insert = (rows) => ins(Array.isArray(rows) ? rows : [rows]); return b; };
  return f;
}
const admin = { authorization: "Bearer " + jwt.sign({ role: "admin", user: "a" }, process.env.JWT_SECRET) };
const noDob = (txt) => !/1987|06-05|06\/05|date_of_birth|"dob"/.test(txt);

const tests = [];
const t = (n, f) => tests.push([n, f]);

t("GET /candidates has no date of birth", async () => {
  fake = seed();
  const r = await handler({ httpMethod: "GET", path: "/candidates", headers: admin });
  assert.strictEqual(r.statusCode, 200, r.body);
  assert.strictEqual(JSON.parse(r.body).data.candidates[0].email, "val@example.com");
  assert.ok(noDob(r.body), r.body);
});

t("GET /candidates/:id has no date of birth", async () => {
  fake = seed();
  const r = await handler({ httpMethod: "GET", path: "/candidates/app-1", headers: admin });
  assert.strictEqual(r.statusCode, 200, r.body);
  assert.strictEqual(JSON.parse(r.body).data.id, "app-1");
  assert.ok(noDob(r.body), r.body);
});

t("createCheck still sends DOB to Checkr server-side, and not back to the browser", async () => {
  fake = seed();
  const sent = [];
  const realFetch = global.fetch;
  global.fetch = async (url, opts) => {
    sent.push({ url, body: JSON.parse(opts.body) });
    const json = url.endsWith("/candidates") ? { id: "cand_1" } : { id: "rep_1", status: "pending" };
    return { ok: true, json: async () => json };
  };
  try {
    const r = await handler({ httpMethod: "POST", path: "/candidates/app-1/create", headers: admin, body: JSON.stringify({ package: "driver_pro" }) });
    assert.ok(r.statusCode < 300, r.statusCode + " " + r.body);
    assert.ok(noDob(r.body), r.body);
  } finally { global.fetch = realFetch; }
  const cand = sent.find((s) => s.url.endsWith("/candidates"));
  assert.ok(cand && cand.body.dob, "dob sent to Checkr");
  assert.ok(cand.url.startsWith("https://api.checkr.com/"));
});

t("admin Checkr page no longer renders Date of Birth", () => {
  const js = fs.readFileSync(path.join(ROOT, "frontend/admin/checkr.js"), "utf8");
  assert.ok(!/Date of Birth/i.test(js) && !/candidate\.dob/.test(js));
});

(async () => {
  let failed = 0;
  for (const [n, f] of tests) {
    try { await f(); console.log("ok -", n); } catch (e) { failed++; console.error("not ok -", n, "\n ", e.message); }
  }
  console.log(failed ? `${failed} failed` : `checkr-no-dob: ${tests.length} passed`);
  process.exit(failed ? 1 : 0);
})();
