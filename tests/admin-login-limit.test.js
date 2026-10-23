#!/usr/bin/env node
/**
 * Admin login: timing-safe credential check, plus a rate limit / lockout kept
 * in Supabase (admin_login_attempts) so it holds across serverless instances.
 * Fails open (still timing-safe) when the table is missing. No network.
 */
"use strict";
const assert = require("assert");
const path = require("path");
const fs = require("fs");
const Module = require("module");
const { createFakeSupabase } = require("./helpers/fake-supabase");

process.env.SITE_ORIGIN = "https://coyote-dune-delivery.netlify.app";
process.env.ADMIN_USERNAME = "ops-test";
process.env.ADMIN_PASSWORD = "not-a-real-password-123";
process.env.JWT_SECRET = "test-login-admin-secret-32bytes!!";
process.env.SUPABASE_URL = "https://fake.supabase.test";
process.env.SUPABASE_SERVICE_KEY = "fake-service-key";

let fake = null;
const realLoad = Module._load;
Module._load = function (request) {
  if (request === "@supabase/supabase-js") return { createClient: () => fake };
  return realLoad.apply(this, arguments);
};
const ROOT = path.join(__dirname, "..");
const login = require(path.join(ROOT, "netlify/functions/login-admin.js")).handler;

const call = (password, ip, username) => login({
  httpMethod: "POST",
  headers: { "x-nf-client-connection-ip": ip || "203.0.113.5" },
  body: JSON.stringify({ username: username || "ops-test", password }),
});
const quiet = async (fn) => {
  const w = console.warn, e = console.error; console.warn = () => {}; console.error = () => {};
  try { return await fn(); } finally { console.warn = w; console.error = e; }
};
const GOOD = "not-a-real-password-123";
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test("source: timing-safe compare, no plain !== on the credentials", () => {
  const src = fs.readFileSync(path.join(ROOT, "netlify/functions/login-admin.js"), "utf8");
  assert.ok(/crypto\.timingSafeEqual\(/.test(src));
  assert.ok(!/password\s*!==\s*adminPass|username\s*!==\s*adminUser/.test(src));
});

test("5 wrong passwords from one IP: 5th answers 429 locked; the right password is then refused too", async () => {
  fake = createFakeSupabase({ admin_login_attempts: [] });
  for (let i = 1; i <= 4; i++) assert.strictEqual((await call("nope-" + i)).statusCode, 401, "try " + i);
  const fifth = await call("nope-5");
  assert.strictEqual(fifth.statusCode, 429, fifth.body);
  const out = JSON.parse(fifth.body);
  assert.strictEqual(out.code, "login_locked");
  assert.strictEqual(out.error, "Too many failed sign-in attempts. Try again in 15 minutes.");
  assert.ok(Number(fifth.headers["Retry-After"]) > 800);
  const locked = await call(GOOD);
  assert.strictEqual(locked.statusCode, 429, "locked even with the right password");
  assert.ok(!JSON.parse(locked.body).token);
});

test("lock is per IP: another IP still signs in, and success clears its counter", async () => {
  fake = createFakeSupabase({ admin_login_attempts: [] });
  for (let i = 0; i < 5; i++) await call("nope");
  const other = await call(GOOD, "198.51.100.7");
  assert.strictEqual(other.statusCode, 200, other.body);
  assert.ok(JSON.parse(other.body).token);
});

test("success before the limit resets the count", async () => {
  fake = createFakeSupabase({ admin_login_attempts: [] });
  for (let i = 0; i < 4; i++) await call("nope");
  assert.strictEqual((await call(GOOD)).statusCode, 200);
  for (let i = 0; i < 4; i++) assert.strictEqual((await call("nope")).statusCode, 401);
});

test("lock expires; failures older than the window don't count", async () => {
  const past = new Date(Date.now() - 16 * 60 * 1000).toISOString();
  fake = createFakeSupabase({ admin_login_attempts: [
    { key: "ip:203.0.113.5", failures: 5, first_failed_at: past, locked_until: new Date(Date.now() - 60000).toISOString() },
  ] });
  assert.strictEqual((await call("nope")).statusCode, 401, "old window: counted as the 1st failure, not locked");
  assert.strictEqual(fake.db.admin_login_attempts.find((r) => r.key === "ip:203.0.113.5").failures, 1);
  assert.strictEqual((await call(GOOD)).statusCode, 200);
});

test("many IPs guessing one username: locked at 20 per username", async () => {
  fake = createFakeSupabase({ admin_login_attempts: [] });
  for (let i = 0; i < 19; i++) assert.strictEqual((await call("nope", "10.0.0." + i)).statusCode, 401);
  assert.strictEqual((await call("nope", "10.0.1.1")).statusCode, 429);
});

test("table missing (migration not run): fails open, still timing-safe, warns", async () => {
  const base = createFakeSupabase({});
  const missing = { code: "PGRST205", message: "Could not find the table 'public.admin_login_attempts' in the schema cache" };
  const errB = () => { const b = { select: () => b, in: () => b, eq: () => b, update: () => b, insert: () => b, then: (r) => r({ data: null, error: missing }) }; return b; };
  fake = { from: (t) => (t === "admin_login_attempts" ? errB() : base.from(t)) };
  const warns = [];
  const w = console.warn; console.warn = (...a) => warns.push(a.join(" "));
  try {
    for (let i = 0; i < 7; i++) assert.strictEqual((await call("nope")).statusCode, 401);
    assert.strictEqual((await call(GOOD)).statusCode, 200);
  } finally { console.warn = w; }
  assert.ok(warns.some((m) => /admin_login_attempts table missing/.test(m)));
});

test("Supabase throwing or not configured: login still works", async () => {
  fake = { from() { throw new Error("boom"); } };
  assert.strictEqual((await quiet(() => call(GOOD))).statusCode, 200);
  assert.strictEqual((await quiet(() => call("nope"))).statusCode, 401);
  const u = process.env.SUPABASE_URL; delete process.env.SUPABASE_URL;
  try { assert.strictEqual((await call(GOOD)).statusCode, 200); } finally { process.env.SUPABASE_URL = u; }
});

test("wrong username, empty or non-string password: 401, no crash", async () => {
  fake = createFakeSupabase({ admin_login_attempts: [] });
  assert.strictEqual((await call(GOOD, "192.0.2.1", "someone")).statusCode, 401);
  for (const p of ["", null, 12345, { x: 1 }]) {
    const res = await login({ httpMethod: "POST", headers: { "x-nf-client-connection-ip": "192.0.2.2" }, body: JSON.stringify({ username: "ops-test", password: p }) });
    assert.strictEqual(res.statusCode, 401, String(p));
  }
});

test("migration file + LAUNCH.md step", () => {
  const sql = fs.readFileSync(path.join(ROOT, "schema/admin_login_attempts.sql"), "utf8");
  assert.ok(/CREATE TABLE IF NOT EXISTS admin_login_attempts/.test(sql));
  assert.ok(/ENABLE ROW LEVEL SECURITY/.test(sql));
  assert.ok(!/CREATE POLICY/.test(sql), "service role only");
  const md = fs.readFileSync(path.join(ROOT, "LAUNCH.md"), "utf8");
  assert.ok(md.includes("**Step 9 (recommended): `schema/admin_login_attempts.sql`.**"));
  assert.ok(md.includes("### Step 9 on Supabase: `admin_login_attempts.sql`"));
});

(async () => {
  let failed = 0;
  for (const [name, fn] of tests) {
    try { await fn(); console.log("ok -", name); }
    catch (e) { failed++; console.error("not ok -", name, "\n ", e.message); }
  }
  console.log(`\nadmin-login-limit: ${tests.length - failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
