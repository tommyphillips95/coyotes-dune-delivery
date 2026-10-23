#!/usr/bin/env node
// LAUNCH.md steps 5-9 + the driver-documents bucket: each is a copy-paste
// section (Purpose / Run / Verify / Undo) whose paste block is the exact file,
// and schema/verify-schema.sql (read-only) covers step 9 and the bucket.
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const ROOT = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
const md = read("LAUNCH.md");
const exists = (p) => fs.existsSync(path.join(ROOT, p));
const section = (head) => {
  const i = md.indexOf(head);
  assert(i > -1, "LAUNCH.md has " + head);
  const j = md.indexOf("\n### ", i + 5);
  return md.slice(i, j < 0 ? md.length : j);
};
const sqlBlocks = (s) => [...s.matchAll(/```sql\n([\s\S]*?)```/g)].map((m) => m[1].trim());
const BUCKET_TYPES = ["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif", "application/pdf"];
const tests = [];
const test = (n, f) => tests.push([n, f]);

const STEPS = [
  ["### Step 5 on Supabase: `order_idempotency.sql`", "schema/order_idempotency.sql", true],
  ["### Step 6 on Supabase: `customer_phone_normalize.sql`", "schema/customer_phone_normalize.sql", false],
  ["### Step 7 on Supabase: `vehicle_verification.sql`", "schema/vehicle_verification.sql", true],
  ["### Step 8 on Supabase: `driver_consents.sql`", "schema/driver_consents.sql", true],
  ["### Step 9 on Supabase: `admin_login_attempts.sql`", "schema/admin_login_attempts.sql", true],
];

test("steps 5-9 and the bucket each have Purpose, Run (SQL Editor), Verify (with a query) and Undo", () => {
  for (const head of STEPS.map((s) => s[0]).concat("### Bucket: `driver-documents`")) {
    const s = section(head);
    for (const lab of ["**Purpose", "**Run:**", "**Verify:**", "**Undo"]) assert(s.includes(lab), head + " has " + lab);
    assert(/SQL Editor/.test(s), head + " says where to paste");
    assert(sqlBlocks(s).length >= 1, head + " has a paste block");
    assert(/`[^`]*(DROP|DELETE)[^`]*`/.test(s.slice(s.indexOf("**Undo"))), head + " undo is a command");
  }
});

test("each short step pastes exactly its schema file; step 6 names its file", () => {
  for (const [head, file, inline] of STEPS) {
    const s = section(head);
    if (inline) assert.strictEqual(sqlBlocks(s)[0], read(file).trim(), head + " paste == " + file);
    else assert(s.includes("`" + file + "`"), head + " names " + file);
  }
});

test("bucket paste block: private, 4 MB = the upload limit, exactly the six types", () => {
  const card = require(path.join(ROOT, "netlify/functions/_insurance-card.js"));
  const src = read("netlify/functions/_insurance-card.js");
  const s = section("### Bucket: `driver-documents`");
  const sql = sqlBlocks(s)[0];
  assert(/INSERT INTO storage\.buckets/.test(sql) && /ON CONFLICT \(id\) DO UPDATE/.test(sql), "re-runnable insert");
  assert(sql.includes("'" + (card.BUCKET || "driver-documents") + "'"));
  assert(/'driver-documents', 'driver-documents', false, 4194304/.test(sql));
  assert.strictEqual(4194304, 4 * 1024 * 1024);
  assert(/MAX_BYTES = 4 \* 1024 \* 1024/.test(src), "upload limit is still 4 MB");
  const types = /ARRAY\[([^\]]+)\]/.exec(sql)[1].match(/'[^']+'/g).map((t) => t.slice(1, -1));
  assert.deepStrictEqual(types.slice().sort(), BUCKET_TYPES.slice().sort());
  for (const m of src.matchAll(/mime: "([^"]+)"/g)) assert(types.includes(m[1]), "bucket allows sniffed " + m[1]);
  assert(md.includes("[Paste, verify, undo](#bucket-driver-documents)"), "deploy block links the bucket section");
});

test("schema/verify-schema.sql is read-only and covers steps 5-9 and the bucket", () => {
  assert(exists("schema/verify-schema.sql"), "schema/verify-schema.sql committed");
  const v = read("schema/verify-schema.sql");
  const code = v.split("\n").filter((l) => !/^\s*--/.test(l)).join("\n");
  assert(!/\b(INSERT|UPDATE|DELETE|ALTER|CREATE|DROP|TRUNCATE|GRANT)\b/.test(code.replace(/'[^']*'/g, "''")), "only SELECTs");
  for (const st of ["5", "6", "7", "8", "9", "bucket"]) assert(code.includes("SELECT '" + st + "'"), "covers step " + st);
  assert(/WHEN '9' THEN/.test(code), "step 9 sorted");
});

test("verify-schema.sql step 9: every admin_login_attempts column, the primary key and RLS", () => {
  const v = read("schema/verify-schema.sql");
  const create = /CREATE TABLE IF NOT EXISTS admin_login_attempts \(([\s\S]*?)\n\);/.exec(read("schema/admin_login_attempts.sql"))[1];
  const cols = create.split("\n").map((l) => l.trim().split(/\s+/)[0]).filter(Boolean);
  assert.deepStrictEqual(cols, ["key", "failures", "first_failed_at", "locked_until", "updated_at"]);
  for (const c of cols) assert(v.includes("column_name = '" + c + "'") && v.includes("admin_login_attempts." + c), "checks column " + c);
  assert(/i\.indisprimary/.test(v) && v.includes("admin_login_attempts_pkey"), "checks the primary key index");
  assert(/relrowsecurity/.test(v) && /pg_policies/.test(v), "checks RLS on, no policies");
});

test("verify-schema.sql bucket checks match the paste block", () => {
  const v = read("schema/verify-schema.sql");
  assert(/public IS FALSE/.test(v) && /4194304/.test(v));
  for (const t of BUCKET_TYPES) assert(v.includes("'" + t + "'"), t);
  assert(md.includes("`schema/verify-schema.sql`"), "LAUNCH points at it");
});

let failed = 0;
for (const [n, f] of tests) { try { f(); console.log("ok -", n); } catch (e) { failed++; console.error("not ok -", n, "\n ", e.message); } }
console.log(failed ? `${failed} failed` : `launch-sql-steps: ${tests.length} passed`);
process.exit(failed ? 1 : 0);
