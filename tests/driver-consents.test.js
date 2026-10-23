#!/usr/bin/env node
/**
 * Driver consent records (schema/driver_consents.sql, LAUNCH.md step 8).
 * Before: submit-application checked all four consent boxes but stored only
 * background_check_consent, with no time of acceptance. Now all four are
 * stored with a server-side consents_accepted_at, and the application is
 * still saved (201, with a warning) if the SQL hasn't been run yet.
 * Supabase is faked; no network, no SQL is run.
 */
"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const Module = require("module");
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

const ROOT = path.join(__dirname, "..");
const SQL_PATH = "schema/driver_consents.sql";
const submit = require(path.join(ROOT, "netlify/functions/submit-application.js"));

const COLS = ["background_check_disclosure_read", "esignature_consent", "terms_consent", "consents_accepted_at"];
const VEHICLE = ["vehicle_class_reported"];

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

/** Run fn with console.warn/error captured. */
async function capture(fn) {
  const logs = []; const w = console.warn, e = console.error, l = console.log;
  console.warn = (...a) => logs.push(["warn", a.join(" ")]);
  console.error = (...a) => logs.push(["error", a.join(" ")]);
  console.log = () => {};
  try { return { res: await fn(), logs }; } finally { console.warn = w; console.error = e; console.log = l; }
}

/** Fake DB; `missing` columns make an applications insert fail like PostgREST does. */
function freshFake(missing = [], code = "PGRST204") {
  fake = createFakeSupabase({ applications: [], documents: [] });
  const attempts = [];
  const from = fake.from;
  fake.from = (name) => {
    const b = from(name);
    if (name !== "applications") return b;
    const insert = b.insert;
    b.insert = (rows) => {
      const list = [].concat(rows);
      attempts.push(list.map((r) => Object.keys(r)));
      const col = missing.find((c) => list.some((r) => c in r));
      if (!col) return insert(rows);
      const error = code === "42703"
        ? { code, message: `column "${col}" of relation "applications" does not exist` }
        : { code, message: `Could not find the '${col}' column of 'applications' in the schema cache` };
      const fail = { select() { return fail; }, single() { return fail; }, maybeSingle() { return fail; }, then(res) { res({ data: null, error }); } };
      return fail;
    };
    return b;
  };
  return attempts;
}

const BODY = { firstName: "J", lastName: "S", email: "j@example.com", vehicleClass: "2wd", bgConsent: true, bgDisclosureRead: true, esignature: true, termsAgree: true };
const post = (b) => capture(() => submit.handler({ httpMethod: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }));

test("all four consents and a server timestamp are stored", async () => {
  freshFake();
  const before = Date.now();
  const { res } = await post(BODY);
  const after = Date.now();
  assert.strictEqual(res.statusCode, 201, res.body);
  const row = fake.db.applications[0];
  assert.deepStrictEqual([row.background_check_consent, row.background_check_disclosure_read, row.esignature_consent, row.terms_consent], [true, true, true, true]);
  const t = Date.parse(row.consents_accepted_at);
  assert.ok(t >= before && t <= after, "timestamp taken at acceptance: " + row.consents_accepted_at);
  assert.strictEqual(new Date(t).toISOString(), row.consents_accepted_at, "ISO string");
});

test("client-sent timestamps and consent columns are ignored", async () => {
  freshFake();
  const { res } = await post(Object.assign({}, BODY, { consents_accepted_at: "2001-01-01T00:00:00Z", consentsAcceptedAt: "2001-01-01T00:00:00Z", terms_consent: "nope" }));
  assert.strictEqual(res.statusCode, 201, res.body);
  const row = fake.db.applications[0];
  assert.ok(Date.parse(row.consents_accepted_at) > Date.parse("2026-01-01"), row.consents_accepted_at);
  assert.strictEqual(row.terms_consent, true);
});

test("bgConsent alias background_check_consent still works and is stored with the rest", async () => {
  freshFake();
  const b = Object.assign({}, BODY); delete b.bgConsent; b.background_check_consent = "on";
  const { res } = await post(b);
  assert.strictEqual(res.statusCode, 201, res.body);
  const row = fake.db.applications[0];
  COLS.forEach((c) => assert.ok(row[c] !== undefined && row[c] !== null, c));
  assert.strictEqual(row.background_check_consent, true);
});

test("a missing consent is still rejected with 400 and nothing stored", async () => {
  for (const f of ["bgConsent", "bgDisclosureRead", "esignature", "termsAgree"]) {
    freshFake();
    const b = Object.assign({}, BODY); delete b[f];
    const { res } = await post(b);
    assert.strictEqual(res.statusCode, 400, f);
    assert.strictEqual(fake.db.applications.length, 0, f);
  }
});

for (const code of ["PGRST204", "42703"]) {
  test(`before driver_consents.sql runs (${code}): saved with 201 without the new columns, warning logged`, async () => {
    const attempts = freshFake(COLS, code);
    const { res, logs } = await post(BODY);
    assert.strictEqual(res.statusCode, 201, res.body);
    assert.strictEqual(fake.db.applications.length, 1);
    const row = fake.db.applications[0];
    COLS.forEach((c) => assert.ok(!(c in row), c + " dropped"));
    assert.strictEqual(row.background_check_consent, true, "existing column kept");
    assert.strictEqual(attempts.length, 2, "one retry");
    assert.ok(logs.some(([lvl, m]) => lvl === "warn" && /driver_consents\.sql/.test(m)), "warning: " + JSON.stringify(logs));
  });
}

test("neither driver_consents.sql nor vehicle_verification.sql run: still saved with 201", async () => {
  const attempts = freshFake(COLS.concat(VEHICLE));
  const { res, logs } = await post(BODY);
  assert.strictEqual(res.statusCode, 201, res.body);
  const row = fake.db.applications[0];
  COLS.concat(VEHICLE).forEach((c) => assert.ok(!(c in row), c));
  assert.strictEqual(row.vehicle_class, "2wd");
  assert.strictEqual(attempts.length, 3);
  assert.strictEqual(logs.filter(([l]) => l === "warn").length, 2);
});

test("only vehicle columns missing: consent record is still stored", async () => {
  freshFake(VEHICLE);
  const { res } = await post(BODY);
  assert.strictEqual(res.statusCode, 201, res.body);
  const row = fake.db.applications[0];
  assert.ok(!("vehicle_class_reported" in row));
  COLS.forEach((c) => assert.ok(row[c], c));
});

test("an unrelated insert error is not retried and returns 500", async () => {
  freshFake(["first_name"], "23505");
  const { res } = await post(BODY);
  assert.strictEqual(res.statusCode, 500);
  assert.strictEqual(fake.db.applications.length, 0);
});

// ── schema/driver_consents.sql ────────────────────────────────────────────
const sql = () => fs.readFileSync(path.join(ROOT, SQL_PATH), "utf8");
const statements = () => sql().replace(/--[^\n]*/g, "").split(";").map((s) => s.replace(/\s+/g, " ").trim()).filter(Boolean);

test("driver_consents.sql: only ADD COLUMN IF NOT EXISTS on applications, plus a read-only verify", () => {
  const st = statements();
  const alters = st.filter((s) => /^ALTER\b/i.test(s));
  assert.strictEqual(alters.length, 4);
  alters.forEach((s) => assert.ok(/^ALTER TABLE applications ADD COLUMN IF NOT EXISTS \w+ (BOOLEAN|TIMESTAMPTZ)$/i.test(s), s));
  assert.deepStrictEqual(alters.map((s) => s.split(" ")[8]), COLS);
  assert.ok(/TIMESTAMPTZ$/i.test(alters[3]));
  const rest = st.filter((s) => !/^ALTER\b/i.test(s));
  assert.strictEqual(rest.length, 1, "one verify query");
  assert.ok(/^SELECT\b/i.test(rest[0]) && /information_schema\.columns/.test(rest[0]));
  COLS.forEach((c) => assert.ok(rest[0].includes(`'${c}'`), "verify covers " + c));
});

test("driver_consents.sql: nothing destructive, no defaults, no NOT NULL, no data rewrites", () => {
  const body = statements().join(";\n");
  for (const re of [/\bDROP\b/i, /\bDELETE\b/i, /\bUPDATE\b/i, /\bINSERT\b/i, /\bTRUNCATE\b/i, /\bALTER\s+COLUMN\b/i, /\bTYPE\b/i, /\bRENAME\b/i, /\bDEFAULT\b/i, /\bNOT\s+NULL\b/i, /\bCONSTRAINT\b/i, /\bCREATE\b/i, /\bGRANT\b/i, /\bREVOKE\b/i])
    assert.ok(!re.test(body), "forbidden: " + re);
  const adds = body.match(/ADD COLUMN/gi) || [];
  assert.strictEqual(adds.length, (body.match(/ADD COLUMN IF NOT EXISTS/gi) || []).length, "every ADD COLUMN is IF NOT EXISTS");
});

test("handler column list matches the SQL file", () => {
  assert.deepStrictEqual(submit.CONSENT_COLS, COLS);
});

test("LAUNCH.md: step 8 in the deploy block, run order and its own section", () => {
  const md = fs.readFileSync(path.join(ROOT, "LAUNCH.md"), "utf8");
  const start = md.indexOf("## Before the next production deploy");
  const block = md.slice(start, md.indexOf("\n## ", start + 5));
  const order = ["schema/vehicle_verification.sql", SQL_PATH, "`driver-documents`", "Then the production deploy"].map((t) => block.indexOf(t));
  order.forEach((i, n) => assert.ok(i > -1 && (n === 0 || i > order[n - 1]), "block order " + n));
  assert.ok(/Step 8 \(required for consent records\)/.test(block));
  assert.ok(/^8\. .*`schema\/driver_consents\.sql`/m.test(md), "run order line");
  const sec = md.slice(md.indexOf("### Step 8 on Supabase"));
  assert.ok(md.includes("### Step 8 on Supabase: `driver_consents.sql`"));
  assert.ok(/SQL Editor/.test(sec) && /all `true`/.test(sec) && /still/.test(sec));
});

(async () => {
  console.log("driver-consents.test.js");
  let failed = 0;
  for (const [name, fn] of tests) {
    try { await fn(); console.log("ok - " + name); }
    catch (e) { failed++; console.log("not ok - " + name); console.log("  " + (e && e.stack || e)); }
  }
  if (failed) { console.error(`driver-consents: ${failed} failed`); process.exit(1); }
  console.log(`driver-consents: ${tests.length} passed`);
})();
