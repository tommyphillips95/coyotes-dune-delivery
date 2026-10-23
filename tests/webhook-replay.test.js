#!/usr/bin/env node
/**
 * Checkr + Stripe webhooks: duplicates/replays change nothing, malformed
 * input gets a 4xx (no crash), and signature details are never logged.
 */
"use strict";
const assert = require("assert");
const path = require("path");
const crypto = require("crypto");
const Module = require("module");
const { createFakeSupabase } = require("./helpers/fake-supabase");

process.env.STRIPE_SECRET_KEY = "sk_test_mocked_not_a_real_key";
process.env.STRIPE_WEBHOOK_SECRET = "whsec_mocked";
process.env.SUPABASE_URL = "https://fake.supabase.test";
process.env.SUPABASE_SERVICE_KEY = "fake-service-key";
process.env.CHECKR_WEBHOOK_SECRET = "chk-secret-test";

let fake = null;
const SIG_ERR = Object.assign(new Error("No signatures found"), { header: "t=1,v1=SIGHEADERSECRET", payload: "{\"email\":\"PIIBODY\"}" });
const realLoad = Module._load;
Module._load = function (request) {
  if (request === "@supabase/supabase-js") return { createClient: () => fake };
  if (request === "stripe") return function Stripe() { return { webhooks: { constructEvent: (raw, sig) => { if (sig === "bad") throw SIG_ERR; return JSON.parse(raw); } } }; };
  return realLoad.apply(this, arguments);
};
const ROOT = path.join(__dirname, "..");
const dispatch = require(path.join(ROOT, "netlify/functions/dispatch.js"));
dispatch.offerNext = async () => ({ offered: false, reason: "test" });
const stripeHook = require(path.join(ROOT, "netlify/functions/payment-webhook.js")).handler;
const checkrHook = require(path.join(ROOT, "netlify/functions/checkr-webhook.js")).handler;

const sign = (b) => crypto.createHmac("sha256", "chk-secret-test").update(b, "utf8").digest("hex");
const checkrEvt = (id, status, created_at) => JSON.stringify({ type: "report.completed", id, created_at, data: { object: { id: "rep1", status } } });
const postCheckr = (body, extra) => checkrHook(Object.assign({ httpMethod: "POST", headers: { "X-Checkr-Signature": sign(body) }, body }, extra));
const appDb = (status) => createFakeSupabase({
  applications: [{ id: "a1", status: status || "background_check", background_check_status: "pending", background_check_report_id: "rep1" }],
  background_check_logs: [],
});

function captureLogs(fn) {
  const out = []; const o = { e: console.error, w: console.warn, l: console.log };
  console.error = console.warn = console.log = (...a) => out.push(a.map((x) => (typeof x === "string" ? x : require("util").inspect(x, { depth: 5 }))).join(" "));
  return Promise.resolve().then(fn).finally(() => { console.error = o.e; console.warn = o.w; console.log = o.l; }).then(() => out.join("\n"));
}

const tests = [];
const test = (n, f) => tests.push([n, f]);

test("checkr: same event delivered twice → second is a no-op (one log row)", async () => {
  fake = appDb();
  const b = checkrEvt("ev1", "clear", "2026-10-01T00:00:00Z");
  assert.strictEqual((await postCheckr(b)).statusCode, 200);
  assert.strictEqual(fake.db.applications[0].status, "approved");
  fake.db.applications[0].status = "on_hold"; // admin put the driver on hold afterwards
  const r = await postCheckr(b);
  assert.strictEqual(r.statusCode, 200);
  assert.strictEqual(fake.db.applications[0].status, "on_hold");
  assert.strictEqual(fake.db.background_check_logs.length, 1);
});

test("checkr: an older event replayed after a newer one changes nothing", async () => {
  fake = appDb();
  await postCheckr(checkrEvt("ev2", "consider", "2026-10-02T00:00:00Z"));
  const r = await postCheckr(checkrEvt("ev1", "clear", "2026-10-01T00:00:00Z"));
  assert.strictEqual(r.statusCode, 200);
  assert.strictEqual(fake.db.applications[0].background_check_status, "consider");
  assert.strictEqual(fake.db.applications[0].status, "on_hold");
});

test("checkr: a 'clear' never re-approves a rejected application", async () => {
  fake = appDb("rejected");
  await postCheckr(checkrEvt("ev9", "clear", "2026-10-03T00:00:00Z"));
  assert.strictEqual(fake.db.applications[0].status, "rejected");
});

test("checkr: no headers / malformed / non-object bodies → 4xx, no crash", async () => {
  fake = appDb();
  assert.strictEqual((await checkrHook({ httpMethod: "POST", body: "{}" })).statusCode, 401);
  for (const b of ["null", "42", "[]", "\"x\"", "{bad"]) {
    const r = await postCheckr(b);
    assert.ok(r.statusCode >= 400 && r.statusCode < 500, b + " → " + r.statusCode);
  }
  assert.strictEqual(fake.db.applications[0].status, "background_check");
});

test("checkr: base64-encoded body is verified and processed", async () => {
  fake = appDb();
  const b = checkrEvt("ev3", "clear", "2026-10-01T00:00:00Z");
  const r = await checkrHook({ httpMethod: "POST", headers: { "x-checkr-signature": sign(b) }, body: Buffer.from(b).toString("base64"), isBase64Encoded: true });
  assert.strictEqual(r.statusCode, 200);
  assert.strictEqual(fake.db.applications[0].status, "approved");
});

test("checkr: secret and signature never appear in logs", async () => {
  fake = appDb();
  const logs = await captureLogs(async () => {
    await postCheckr("{bad");
    await checkrHook({ httpMethod: "POST", headers: { "x-checkr-signature": "ab".repeat(32) }, body: "{}" });
  });
  assert.ok(!logs.includes("chk-secret-test") && !logs.includes("abababab"), logs);
});

const orderDb = (o) => createFakeSupabase({
  orders: [Object.assign({ id: "o1", status: "pending", payment_status: "pending", stripe_payment_intent_id: "pi_1" }, o)],
  order_status_logs: [], dispatch_offers: [], applications: [],
});
const sendStripe = (obj, sig) => stripeHook({ httpMethod: "POST", headers: { "stripe-signature": sig || "t=1,v1=mock" }, body: JSON.stringify(obj) });

test("stripe: duplicate payment_failed / canceled → one log row", async () => {
  for (const type of ["payment_intent.payment_failed", "payment_intent.canceled"]) {
    fake = orderDb();
    const ev = { id: "evt_f", type, data: { object: { id: "pi_1", metadata: { order_id: "o1" } } } };
    assert.strictEqual((await sendStripe(ev)).statusCode, 200);
    assert.strictEqual((await sendStripe(ev)).statusCode, 200);
    assert.strictEqual(fake.db.order_status_logs.length, 1, type);
  }
});

test("stripe: signed event with no data object → 400, no crash", async () => {
  fake = orderDb();
  for (const ev of [{ id: "e", type: "payment_intent.succeeded" }, { id: "e", type: "payment_intent.succeeded", data: null }]) {
    const r = await sendStripe(ev);
    assert.strictEqual(r.statusCode, 400);
  }
});

test("stripe: missing or bad signature → 400, nothing changed, header/body not logged", async () => {
  fake = orderDb();
  const logs = await captureLogs(async () => {
    const ev = { id: "e", type: "payment_intent.succeeded", data: { object: { id: "pi_1", metadata: { order_id: "o1" } } } };
    assert.strictEqual((await stripeHook({ httpMethod: "POST", body: JSON.stringify(ev) })).statusCode, 400);
    assert.strictEqual((await sendStripe(ev, "bad")).statusCode, 400);
  });
  assert.strictEqual(fake.db.orders[0].payment_status, "pending");
  assert.ok(!logs.includes("SIGHEADERSECRET") && !logs.includes("PIIBODY") && !logs.includes("whsec_mocked"), logs);
});

(async () => {
  let failed = 0;
  for (const [n, f] of tests) {
    try { await f(); console.log("  ok  " + n); } catch (e) { failed++; console.log("  FAIL " + n + "\n    " + (e.message || e).toString().split("\n")[0]); }
  }
  if (failed) { console.log(failed + " failed"); process.exit(1); }
})();
