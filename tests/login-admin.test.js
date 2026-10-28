#!/usr/bin/env node
/**
 * /api/admin/login uses the shared CORS lock (_cors.js / SITE_ORIGIN), not '*',
 * and still logs in / refuses as before. No network.
 */
const assert = require("assert");
const path = require("path");
const fs = require("fs");
const jwt = require("jsonwebtoken");

const ROOT = path.join(__dirname, "..");
const SITE = "https://coyote-dune-delivery.netlify.app";
process.env.SITE_ORIGIN = SITE;
process.env.ADMIN_USERNAME = "ops-test";
process.env.ADMIN_PASSWORD = "not-a-real-password-123";
process.env.JWT_SECRET = "test-login-admin-secret-32bytes!!";

const login = require(path.join(ROOT, "netlify/functions/login-admin.js"));
const call = (method, origin, body) => login.handler({
  httpMethod: method,
  headers: origin ? { origin } : {},
  body: body ? JSON.stringify(body) : undefined,
});

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test("no wildcard CORS in login-admin.js; uses _cors", () => {
  const src = fs.readFileSync(path.join(ROOT, "netlify/functions/login-admin.js"), "utf8");
  assert.ok(!/Access-Control-Allow-Origin['"]?\s*:\s*['"]\*/.test(src), "no '*' origin");
  assert.ok(/require\(['"]\.\/_cors['"]\)/.test(src));
});

test("preflight from the site gets the site origin back", async () => {
  const res = await call("OPTIONS", SITE);
  assert.strictEqual(res.statusCode, 204);
  assert.strictEqual(res.headers["Access-Control-Allow-Origin"], SITE);
  assert.strictEqual(res.headers.Vary, "Origin");
  assert.match(res.headers["Access-Control-Allow-Methods"], /POST/);
  assert.match(res.headers["Access-Control-Allow-Headers"], /Content-Type/);
});

test("a foreign origin is not echoed (browser will block it)", async () => {
  for (const evil of ["https://evil.example", "null"]) {
    const res = await call("POST", evil, { username: "x", password: "y" });
    assert.notStrictEqual(res.headers["Access-Control-Allow-Origin"], evil);
    assert.notStrictEqual(res.headers["Access-Control-Allow-Origin"], "*");
    assert.strictEqual(res.headers["Access-Control-Allow-Origin"], SITE);
  }
});

test("SITE_ORIGIN list: each listed origin is allowed", async () => {
  process.env.SITE_ORIGIN = SITE + ", https://deploy-preview-9--coyote-dune-delivery.netlify.app";
  try {
    const res = await call("OPTIONS", "https://deploy-preview-9--coyote-dune-delivery.netlify.app");
    assert.strictEqual(res.headers["Access-Control-Allow-Origin"], "https://deploy-preview-9--coyote-dune-delivery.netlify.app");
  } finally {
    process.env.SITE_ORIGIN = SITE;
  }
});

test("login still works and still refuses bad credentials", async () => {
  const ok = await call("POST", SITE, { username: "ops-test", password: "not-a-real-password-123" });
  assert.strictEqual(ok.statusCode, 200);
  assert.strictEqual(jwt.verify(JSON.parse(ok.body).token, process.env.JWT_SECRET).role, "admin");
  assert.strictEqual(ok.headers["Access-Control-Allow-Origin"], SITE);
  const bad = await call("POST", SITE, { username: "ops-test", password: "wrong" });
  assert.strictEqual(bad.statusCode, 401);
  assert.strictEqual((await call("GET", SITE)).statusCode, 405);
});

(async () => {
  let failed = 0;
  for (const [name, fn] of tests) {
    try { await fn(); console.log("ok -", name); }
    catch (err) { failed += 1; console.error("not ok -", name); console.error(err && err.stack ? err.stack : err); }
  }
  if (failed) process.exit(1);
  console.log("login-admin: " + tests.length + " passed");
})();
