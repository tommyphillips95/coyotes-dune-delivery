#!/usr/bin/env node
/**
 * Server functions must not send raw internal error text (DB, Stripe, Twilio,
 * Checkr, config) to the browser. Intentional 4xx messages still pass through.
 * No network: fake Supabase, offline Stripe signature check.
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const Module = require("module");
const jwt = require("jsonwebtoken");
const { createFakeSupabase } = require("./helpers/fake-supabase");

let currentFake = null;
const realLoad = Module._load;
Module._load = function (request) {
  if (request === "@supabase/supabase-js") return { createClient: () => currentFake };
  return realLoad.apply(this, arguments);
};

const SECRET = "test-error-sanitize-secret-32b!!";
process.env.JWT_SECRET = SECRET;
process.env.SUPABASE_URL = "http://example.invalid";
process.env.SUPABASE_SERVICE_KEY = "test";
delete process.env.STRIPE_WEBHOOK_SECRET;
delete process.env.STRIPE_SECRET_KEY;

const ROOT = path.join(__dirname, "..");
const FN = path.join(ROOT, "netlify/functions");
const errors = require(path.join(FN, "_errors.js"));
const { jsonError, authError } = require(path.join(FN, "_auth.js"));

const LEAK = 'relation "applications" does not exist';
const H = { "Content-Type": "application/json" };

// Swallow the server-side logs these paths are supposed to write, but count them.
let logged = [];
const realError = console.error;
function quiet(fn) {
  logged = [];
  console.error = (...a) => logged.push(a.map(String).join(" "));
  return Promise.resolve().then(fn).finally(() => { console.error = realError; });
}

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test("serverError logs the detail and returns a generic 500", () => quiet(() => {
  const res = errors.serverError(H, new Error(LEAK), "Failed to fetch applications", "t");
  assert.strictEqual(res.statusCode, 500);
  assert.deepStrictEqual(JSON.parse(res.body), { error: "Failed to fetch applications" });
  assert.ok(logged.some((l) => l.includes(LEAK)), "detail is logged server-side");
}));

test("errorResponse keeps intentional 4xx messages, hides everything else", () => quiet(() => {
  const e400 = Object.assign(new Error("order_id required"), { status: 400 });
  assert.deepStrictEqual(JSON.parse(errors.errorResponse(H, e400, "x").body), { error: "order_id required" });
  assert.strictEqual(errors.errorResponse(H, e400, "x").statusCode, 400);
  const e503 = Object.assign(new Error("upstream: ECONNRESET 10.0.0.4"), { status: 503 });
  const r503 = errors.errorResponse(H, e503, "Try again");
  assert.strictEqual(r503.statusCode, 503);
  assert.ok(!/ECONNRESET/.test(r503.body));
  assert.ok(!/does not exist/.test(errors.errorResponse(H, new Error(LEAK), "x").body));
}));

test("jsonError: 401/403 pass through, 500 'Auth not configured' does not", () => quiet(() => {
  assert.deepStrictEqual(JSON.parse(jsonError(H, authError(401, "Unauthorized")).body), { error: "Unauthorized" });
  assert.strictEqual(jsonError(H, authError(403, "Admin access required")).statusCode, 403);
  const r = jsonError(H, authError(500, "Auth not configured"));
  assert.strictEqual(r.statusCode, 500);
  assert.ok(!/Auth not configured/.test(r.body), r.body);
}));

test("admin router DB failure returns a generic 500", () => quiet(async () => {
  currentFake = { from() { throw new Error(LEAK); } };
  const admin = require(path.join(FN, "admin.js"));
  const res = await admin.handler({
    httpMethod: "GET",
    path: "/.netlify/functions/admin/applications",
    headers: { origin: "https://coyote-dune-delivery.netlify.app", authorization: "Bearer " + jwt.sign({ role: "admin", user: "ops" }, SECRET) },
    body: null,
  });
  assert.strictEqual(res.statusCode, 500);
  assert.ok(!res.body.includes("does not exist"), res.body);
}));

test("payment-webhook: missing config and bad signature don't echo internals", () => quiet(async () => {
  const hook = require(path.join(FN, "payment-webhook.js"));
  const ev = { httpMethod: "POST", headers: { "stripe-signature": "t=1,v1=deadbeef" }, body: "{}" };
  let res = await hook.handler(ev);
  assert.strictEqual(res.statusCode, 500);
  assert.ok(!/secret|STRIPE|configured/i.test(res.body), res.body);

  process.env.STRIPE_WEBHOOK_SECRET = "whsec_test_offline";
  process.env.STRIPE_SECRET_KEY = "sk_test_offline";
  try {
    res = await hook.handler(ev);
    assert.strictEqual(res.statusCode, 400);
    assert.deepStrictEqual(JSON.parse(res.body), { error: "Invalid signature" });
    assert.ok(logged.length > 0, "signature failure detail is logged");
  } finally {
    delete process.env.STRIPE_WEBHOOK_SECRET;
    delete process.env.STRIPE_SECRET_KEY;
  }
}));

test("no function puts err.message (or a DB error) in a response body", () => {
  const files = fs.readdirSync(FN).filter((f) => f.endsWith(".js") && f !== "_errors.js");
  const bad = [];
  for (const f of files) {
    const src = fs.readFileSync(path.join(FN, f), "utf8");
    src.split("\n").forEach((line, i) => {
      if (/^\s*(\/\/|\*)/.test(line) || /console\.(error|warn|log)/.test(line)) return;
      // internal sendSMS helpers return {success:false, error} to their caller, which only logs it
      if (/return \{ success: false, error: err\.message \};/.test(line)) return;
      // create-payment-intent: resolveChargeAmountCents throws only 400 validation errors
      if (f === "create-payment-intent.js" && /error: e\.message/.test(line)) return;
      if (/(message|error|details|reason)\s*:\s*[\w?.]*\b(err|e|error|fetchError|twilioErr)\??\.message/.test(line) ||
          /message:\s*twilioError/.test(line) || /checkrError\s*=\s*err/.test(line) || /payload\.checkrError/.test(line)) {
        bad.push(f + ":" + (i + 1) + ": " + line.trim());
      }
    });
  }
  assert.deepStrictEqual(bad, [], "raw error text in responses:\n" + bad.join("\n"));
});

(async () => {
  let failed = 0;
  for (const [name, fn] of tests) {
    try {
      await fn();
      console.log("ok -", name);
    } catch (err) {
      failed += 1;
      console.error("not ok -", name);
      console.error(err && err.stack ? err.stack : err);
    }
  }
  if (failed) process.exit(1);
  console.log("error-sanitize: " + tests.length + " passed");
})();
