#!/usr/bin/env node
// The "x-netlify-event: schedule" header is plain text any caller can send.
// offer-next is not a scheduled function, so that header must not get past
// its auth (it would let anyone push order offers to drivers). expire-offers
// is scheduled and keeps accepting it. The internal secret is timing-safe.
const assert = require("assert");
const path = require("path");
const fs = require("fs");
const Module = require("module");
const { createFakeSupabase } = require("./helpers/fake-supabase");

let fromCalls = 0;
const realLoad = Module._load;
Module._load = function (request) {
  if (request === "@supabase/supabase-js") return { createClient: () => { const f = createFakeSupabase({ orders: [], dispatch_offers: [], applications: [] }); const o = f.from.bind(f); f.from = (t) => { fromCalls++; return o(t); }; return f; } };
  if (request === "twilio") throw new Error("twilio must not load");
  return realLoad.apply(this, arguments);
};
process.env.JWT_SECRET = "test-offer-next-secret-32-bytes!!!";
process.env.SUPABASE_URL = "http://example.invalid"; process.env.SUPABASE_SERVICE_KEY = "k";
process.env.SITE_ORIGIN = "https://coyote-dune-delivery.netlify.app";
const ROOT = path.join(__dirname, "..");
const offerNext = require(path.join(ROOT, "netlify/functions/offer-next.js")).handler;
const expire = require(path.join(ROOT, "netlify/functions/expire-offers.js")).handler;
const auth = require(path.join(ROOT, "netlify/functions/_auth.js"));

const tests = []; const test = (n, f) => tests.push([n, f]);

test("offer-next: spoofed schedule header is 401 and touches nothing", async () => {
  fromCalls = 0;
  const r = await offerNext({ httpMethod: "POST", headers: { "x-netlify-event": "schedule" }, body: JSON.stringify({ order_id: "o1" }) });
  assert.strictEqual(r.statusCode, 401, r.body);
  assert.strictEqual(fromCalls, 0);
});

test("requireAdminOrInternal ignores the schedule header unless opted in", () => {
  let st = 0; try { auth.requireAdminOrInternal({ headers: { "x-netlify-event": "schedule" } }); } catch (e) { st = e.status; }
  assert.strictEqual(st, 401);
});

test("expire-offers (scheduled) still runs on the schedule header", async () => {
  const r = await expire({ httpMethod: "POST", headers: { "x-netlify-event": "schedule" }, body: "{}" });
  assert.strictEqual(r.statusCode, 200, r.body);
  assert.ok(/exports\.config\s*=\s*\{\s*schedule:/.test(fs.readFileSync(path.join(ROOT, "netlify/functions/expire-offers.js"), "utf8")));
});

test("internal secret: right value passes, wrong/length-mismatch fails, timing-safe in source", () => {
  process.env.INTERNAL_FUNCTION_SECRET = "s3cret-internal";
  assert.strictEqual(auth.requireAdminOrInternal({ headers: { "x-internal-secret": "s3cret-internal" } }).kind, "internal");
  for (const bad of ["s3cret-interna", "x", "s3cret-internal!"]) {
    let st = 0; try { auth.requireAdminOrInternal({ headers: { "x-internal-secret": bad } }); } catch (e) { st = e.status; }
    assert.strictEqual(st, 401, bad);
  }
  delete process.env.INTERNAL_FUNCTION_SECRET;
  const src = fs.readFileSync(path.join(ROOT, "netlify/functions/_auth.js"), "utf8");
  assert.ok(/timingSafeEqual/.test(src) && !/got === expected/.test(src));
});

(async () => {
  let failed = 0;
  for (const [n, f] of tests) { try { await f(); console.log("ok -", n); } catch (e) { failed++; console.log("not ok -", n, "\n ", e.message); } }
  console.log(failed ? `${failed} failed` : `all ${tests.length} passed`); process.exit(failed ? 1 : 0);
})();
