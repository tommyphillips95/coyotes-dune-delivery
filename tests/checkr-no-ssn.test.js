#!/usr/bin/env node
// Social security numbers: the applications.ssn column was dropped
// (schema/launch_2026_09_22.sql), but checkr.js still mapped ssn into the
// candidate list/detail responses and three Checkr functions still read it
// and forwarded it to Checkr. If the column (or a stray value) ever came back
// it would leak to the admin browser. No function reads or returns it now.
// The seed below deliberately still has an ssn value.
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
const SSN = "123-45-6789";
const seed = () => wrap(createFakeSupabase({
  applications: [{ id: "app-1", first_name: "Val", last_name: "D", email: "val@example.com", zip_code: "78373", status: "pending", date_of_birth: DOB, ssn: SSN, background_check_consent: true, created_at: "2026-10-01" }],
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

const noSsn = (txt) => !/123-45-6789|123456789|"ssn"/.test(txt);
const tests = [];
const t = (n, f) => tests.push([n, f]);

t("GET /candidates has no ssn key or value", async () => {
  fake = seed();
  const r = await handler({ httpMethod: "GET", path: "/candidates", headers: admin });
  assert.strictEqual(r.statusCode, 200, r.body);
  const c = JSON.parse(r.body).data.candidates[0];
  assert.strictEqual(c.email, "val@example.com");
  assert.ok(!("ssn" in c) && noSsn(r.body), r.body);
});

t("GET /candidates/:id has no ssn key or value", async () => {
  fake = seed();
  const r = await handler({ httpMethod: "GET", path: "/candidates/app-1", headers: admin });
  const c = JSON.parse(r.body).data;
  assert.strictEqual(c.id, "app-1");
  assert.ok(!("ssn" in c) && noSsn(r.body), r.body);
});

t("createCheck does not forward an ssn to Checkr", async () => {
  fake = seed();
  const sent = [];
  const realFetch = global.fetch;
  global.fetch = async (url, opts) => {
    sent.push({ url, body: opts.body });
    return { ok: true, json: async () => (url.endsWith("/candidates") ? { id: "cand_1" } : { id: "rep_1", status: "pending" }) };
  };
  try {
    const r = await handler({ httpMethod: "POST", path: "/candidates/app-1/create", headers: admin, body: JSON.stringify({ package: "driver_pro" }) });
    assert.ok(r.statusCode < 300, r.body);
    assert.ok(noSsn(r.body));
  } finally { global.fetch = realFetch; }
  assert.ok(sent.length >= 1);
  sent.forEach((s) => assert.ok(noSsn(s.body), s.url + " " + s.body));
});

t("no Netlify function reads or returns an ssn field", () => {
  const dir = path.join(ROOT, "netlify/functions");
  const hits = [];
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".js"))) {
    fs.readFileSync(path.join(dir, f), "utf8").split("\n").forEach((line, i) => {
      if (/\.ssn\b|\bssn\s*:/.test(line)) hits.push(f + ":" + (i + 1) + ": " + line.trim());
    });
  }
  assert.deepStrictEqual(hits, []);
  // submit-application still refuses an ssn in the request body.
  assert.ok(/forbidden = \['ssn'/.test(fs.readFileSync(path.join(dir, "submit-application.js"), "utf8")));
});

(async () => {
  let failed = 0;
  for (const [n, f] of tests) {
    try { await f(); console.log("ok -", n); } catch (e) { failed++; console.error("not ok -", n, "\n ", e.message); }
  }
  console.log(failed ? `${failed} failed` : `checkr-no-ssn: ${tests.length} passed`);
  process.exit(failed ? 1 : 0);
})();
