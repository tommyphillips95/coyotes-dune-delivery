#!/usr/bin/env node
/**
 * Every Netlify function uses the shared CORS lock (_cors.js / SITE_ORIGIN)
 * instead of 'Access-Control-Allow-Origin: *'.
 *
 * CORS is only enforced by browsers. The helper never refuses a request; it
 * only picks which origin to name in the response header. Server-to-server
 * callers that send no Origin header (Checkr webhooks, curl, cron) still reach
 * the handler. The checkr-webhook tests below prove delivery and HMAC
 * signature checks are unchanged. No network.
 */
"use strict";
const assert = require("assert");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const Module = require("module");
const { createFakeSupabase } = require("./helpers/fake-supabase");

const ROOT = path.join(__dirname, "..");
const FN_DIR = path.join(ROOT, "netlify/functions");
const SITE = "https://coyote-dune-delivery.netlify.app";
const WEBHOOK_SECRET = "test-checkr-webhook-secret";

process.env.SITE_ORIGIN = SITE;
process.env.CHECKR_WEBHOOK_SECRET = WEBHOOK_SECRET;
process.env.SUPABASE_URL = "https://fake.supabase.test";
process.env.SUPABASE_SERVICE_KEY = "fake-service-key";
process.env.JWT_SECRET = "test-cors-functions-secret-32bytes!";

let fake = createFakeSupabase({});
const realLoad = Module._load;
Module._load = function (request) {
  if (request === "@supabase/supabase-js") return { createClient: () => fake };
  return realLoad.apply(this, arguments);
};

// name -> methods that must stay advertised in the preflight
const MOVED = {
  "checkr": ["GET", "POST"],
  "checkr-create-candidate": ["POST"],
  "checkr-initiate": ["POST"],
  "checkr-refresh-report": ["GET"],
  "checkr-webhook": ["POST"],
  "driver-sms-alert": ["POST"],
  "get-applications": ["GET"],
  "log-analytics-event": ["POST"],
  "send-push-notification": ["POST"],
  "send-sms": ["POST"],
  "update-application": ["PUT"],
  "update-order": ["PATCH"],
};
const load = (name) => require(path.join(FN_DIR, name + ".js"));

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test("no function in netlify/functions sends Access-Control-Allow-Origin: *", () => {
  const offenders = fs.readdirSync(FN_DIR).filter((f) => f.endsWith(".js")).filter((f) =>
    /Access-Control-Allow-Origin['"]?\s*:\s*['"]\*['"]/.test(fs.readFileSync(path.join(FN_DIR, f), "utf8")));
  assert.deepStrictEqual(offenders, []);
});

test("each moved function requires ./_cors", () => {
  for (const name of Object.keys(MOVED)) {
    const src = fs.readFileSync(path.join(FN_DIR, name + ".js"), "utf8");
    assert.ok(/require\(['"]\.\/_cors['"]\)/.test(src), name);
  }
});

test("preflight from the site echoes the site and keeps each function's methods", async () => {
  for (const [name, methods] of Object.entries(MOVED)) {
    const res = await load(name).handler({ httpMethod: "OPTIONS", headers: { origin: SITE }, path: "/", queryStringParameters: {} });
    assert.strictEqual(res.statusCode, 204, name);
    assert.strictEqual(res.headers["Access-Control-Allow-Origin"], SITE, name);
    assert.strictEqual(res.headers.Vary, "Origin", name);
    for (const m of methods) assert.match(res.headers["Access-Control-Allow-Methods"], new RegExp(m), name);
  }
});

test("a foreign origin is never echoed back", async () => {
  for (const name of Object.keys(MOVED)) {
    const res = await load(name).handler({ httpMethod: "OPTIONS", headers: { origin: "https://evil.example" }, path: "/", queryStringParameters: {} });
    assert.strictEqual(res.headers["Access-Control-Allow-Origin"], SITE, name);
  }
});

test("checkr-webhook still allows Checkr's signature headers in preflight", async () => {
  const res = await load("checkr-webhook").handler({ httpMethod: "OPTIONS", headers: {} });
  assert.match(res.headers["Access-Control-Allow-Headers"], /X-Checkr-Signature/);
  assert.match(res.headers["Access-Control-Allow-Headers"], /X-Checkr-Webhook-Signature/);
});

test("send-push-notification keeps its JSON Content-Type header", async () => {
  const res = await load("send-push-notification").handler({ httpMethod: "OPTIONS", headers: {} });
  assert.strictEqual(res.headers["Content-Type"], "application/json");
});

const webhookBody = JSON.stringify({ id: "evt_1", type: "report.completed", data: { object: { id: "rep_1", status: "clear" } } });
const sign = (body) => crypto.createHmac("sha256", WEBHOOK_SECRET).update(body, "utf8").digest("hex");

test("checkr-webhook: signed delivery with NO Origin header is processed (server-to-server)", async () => {
  fake = createFakeSupabase({ applications: [{ id: "app-1", status: "pending", background_check_status: "in_progress", background_check_report_id: "rep_1" }] });
  const res = await load("checkr-webhook").handler({
    httpMethod: "POST",
    headers: { "content-type": "application/json", "x-checkr-signature": sign(webhookBody) },
    body: webhookBody,
  });
  assert.strictEqual(res.statusCode, 200);
  const out = JSON.parse(res.body);
  assert.strictEqual(out.processed, true);
  assert.strictEqual(out.backgroundCheckStatus, "clear");
  assert.strictEqual(out.applicationStatus, "approved");
});

test("checkr-webhook: X-Checkr-Webhook-Signature header variant still accepted", async () => {
  fake = createFakeSupabase({ applications: [{ id: "app-2", status: "pending", background_check_report_id: "rep_1" }] });
  const res = await load("checkr-webhook").handler({
    httpMethod: "POST", headers: { "X-Checkr-Webhook-Signature": sign(webhookBody) }, body: webhookBody,
  });
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(JSON.parse(res.body).processed, true);
});

test("checkr-webhook: bad or missing signature is still refused with 401", async () => {
  const wh = load("checkr-webhook");
  const bad = await wh.handler({ httpMethod: "POST", headers: { "x-checkr-signature": sign(webhookBody + "x") }, body: webhookBody });
  assert.strictEqual(bad.statusCode, 401);
  const none = await wh.handler({ httpMethod: "POST", headers: {}, body: webhookBody });
  assert.strictEqual(none.statusCode, 401);
});

test("no-Origin calls reach handler logic (auth still decides, not CORS)", async () => {
  const res = await load("get-applications").handler({ httpMethod: "GET", headers: {}, queryStringParameters: {} });
  assert.strictEqual(res.statusCode, 401);
  const res2 = await load("update-order").handler({ httpMethod: "PATCH", headers: {}, body: "{}" });
  assert.strictEqual(res2.statusCode, 401);
});

(async () => {
  let failed = 0;
  for (const [name, fn] of tests) {
    try { await fn(); console.log("ok -", name); }
    catch (e) { failed++; console.error("not ok -", name, "\n ", e.message); }
  }
  console.log(`\n${tests.length - failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
