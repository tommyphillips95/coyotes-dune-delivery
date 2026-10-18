#!/usr/bin/env node
// Links in customer/driver texts: one builder (_site-url.js), the live
// domain, and the /track/ format the tracking page actually reads.
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const Module = require("module");
const { execSync } = require("child_process");
const ROOT = path.join(__dirname, "..");
const FN = path.join(ROOT, "netlify/functions");
const LIVE = "https://coyote-dune-delivery.netlify.app";
// Built from parts so this file doesn't trip its own repo scan.
const WRONG_HOST = ["coyotes", "dune", "delivery"].join("-") + ".netlify.app";
const OLD_TRACK = "/order/" + "?track=";

const tests = [];
const test = (n, f) => tests.push([n, f]);
const site = () => { delete require.cache[require.resolve(path.join(FN, "_site-url.js"))]; return require(path.join(FN, "_site-url.js")); };

test("siteOrigin: first valid https origin from a comma list, no path/trailing slash", () => {
  const { siteOrigin } = site();
  const o = (v) => siteOrigin({ SITE_ORIGIN: v });
  assert.strictEqual(o("https://coyote-dune-delivery.netlify.app"), LIVE);
  assert.strictEqual(o("https://coyote-dune-delivery.netlify.app/"), LIVE);
  assert.strictEqual(o(" https://coyote-dune-delivery.netlify.app/track/ , https://deploy-preview-9--coyote-dune-delivery.netlify.app"), LIVE);
  assert.strictEqual(o("http://localhost:8888, https://deploy-preview-9--coyote-dune-delivery.netlify.app"), "https://deploy-preview-9--coyote-dune-delivery.netlify.app");
  assert.strictEqual(o(",, not a url ,https://a.example.com:8443/x"), "https://a.example.com:8443");
});

test("siteOrigin: falls back to the live site when unset or invalid", () => {
  const { siteOrigin, DEFAULT_ORIGIN } = site();
  assert.strictEqual(DEFAULT_ORIGIN, LIVE);
  for (const v of [undefined, "", " , ", "coyote-dune-delivery.netlify.app", "http://coyote-dune-delivery.netlify.app", "javascript:alert(1)", "https://user:pw@evil.example", "ftp://x.example"]) {
    assert.strictEqual(siteOrigin({ SITE_ORIGIN: v }), LIVE, String(v));
  }
  const saved = process.env.SITE_ORIGIN; delete process.env.SITE_ORIGIN;
  assert.strictEqual(siteOrigin(), LIVE, "reads process.env by default");
  process.env.SITE_ORIGIN = saved; if (saved === undefined) delete process.env.SITE_ORIGIN;
});

test("trackUrl: /track/?order=<UPPERCASE>, encoded, no double slash, readable by the track page", () => {
  const { trackUrl, siteUrl } = site();
  const env = { SITE_ORIGIN: "https://coyote-dune-delivery.netlify.app/" };
  assert.strictEqual(trackUrl("cdd-ab12cd", env), LIVE + "/track/?order=CDD-AB12CD");
  assert.strictEqual(trackUrl("CDD 1&x=2", env), LIVE + "/track/?order=CDD%201%26X%3D2");
  assert.strictEqual(siteUrl("//driver/", { offer: "a b", none: null }, env), LIVE + "/driver/?offer=a%20b");
  assert.strictEqual(siteUrl("/driver/", {}, env), LIVE + "/driver/");
  // The tracking page parses it back to the same order number.
  global.window = undefined;
  const C = require(path.join(ROOT, "frontend/js/coastal.js"));
  const u = new URL(trackUrl("cdd-ab12cd", env));
  assert.strictEqual(u.pathname, "/track/");
  assert.strictEqual(C.parseOrderParams(u.search).track, "CDD-AB12CD");
  assert.strictEqual(trackUrl("CDD-AB12CD", env).replace(LIVE, ""), C.buildTrackUrl("CDD-AB12CD"), "same format as the in-app Track link");
});

// ── the texts themselves ──
let fake = null;
const sent = [];
const realLoad = Module._load;
Module._load = function (request) {
  if (request === "@supabase/supabase-js") return { createClient: () => fake };
  if (request === "twilio") return () => ({ messages: { create: async (m) => { sent.push(m); return { sid: "SM_test" }; } } });
  return realLoad.apply(this, arguments);
};

test("update-order: assigned text links to SITE_ORIGIN/track/?order=… (not the old domain or /order/?track=)", async () => {
  const { createFakeSupabase } = require("./helpers/fake-supabase");
  const jwt = require("jsonwebtoken");
  Object.assign(process.env, { JWT_SECRET: "test-site-url-secret-32-bytes!!!!", SUPABASE_URL: "http://example.invalid", SUPABASE_SERVICE_KEY: "x",
    SITE_ORIGIN: "https://coyote-dune-delivery.netlify.app/, https://deploy-preview-9--coyote-dune-delivery.netlify.app",
    TWILIO_ACCOUNT_SID: "ACtest", TWILIO_AUTH_TOKEN: "test", TWILIO_PHONE_NUMBER: "+15555550100" }); // fake Twilio client above; nothing leaves the process
  fake = createFakeSupabase({
    orders: [{ id: "o1", order_number: "CDD-LINK01", status: "pending", customer_id: "c1", pickup_city: "Rockport", dropoff_city: "Rockport", required_vehicle_class: "2wd" }],
    customers: [{ id: "c1", phone: "+15555550111" }],
    applications: [{ id: "d1", first_name: "Ray", last_name: "Town", status: "approved", vehicle_class: "2wd", online: true }],
  });
  const fn = require(path.join(FN, "update-order.js"));
  const res = await fn.handler({ httpMethod: "PATCH", headers: { authorization: "Bearer " + jwt.sign({ role: "admin", user: "ops" }, process.env.JWT_SECRET) }, body: JSON.stringify({ id: "o1", driver_id: "d1" }) });
  assert.strictEqual(res.statusCode, 200, res.body);
  assert.strictEqual(sent.length, 1);
  const url = /https?:\/\/\S+/.exec(sent[0].body)[0];
  assert.strictEqual(url, LIVE + "/track/?order=CDD-LINK01");
  assert(!sent[0].body.includes(WRONG_HOST) && !sent[0].body.includes(OLD_TRACK));
  assert.strictEqual(fake.db.sms_logs[0].message, sent[0].body);
  for (const k of ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_PHONE_NUMBER"]) delete process.env[k];
});

test("every function that texts a link uses the shared builder, none reads SITE_ORIGIN by hand", () => {
  const files = fs.readdirSync(FN).filter((f) => f.endsWith(".js") && f !== "_site-url.js");
  const raw = files.filter((f) => /process\.env\.SITE_ORIGIN/.test(fs.readFileSync(path.join(FN, f), "utf8")) && f !== "_cors.js");
  assert.deepStrictEqual(raw, [], "build links with _site-url.js");
  for (const f of ["_assign-sms.js", "respond-offer.js", "dispatch.js", "driver-sms-alert.js", "public-config.js"]) {
    assert(/require\(['"]\.\/_site-url['"]\)/.test(fs.readFileSync(path.join(FN, f), "utf8")), f);
  }
  const ro = fs.readFileSync(path.join(FN, "respond-offer.js"), "utf8");
  assert(/trackUrl\(order\.order_number\)/.test(ro), "respond-offer links to this order");
});

test("netlify.toml: old /order/?track= links redirect to /track/?order= before the /order/* rewrite", () => {
  const toml = fs.readFileSync(path.join(ROOT, "netlify.toml"), "utf8");
  const rule = /\[\[redirects\]\]\s*from = "\/order\/"\s*to = "\/track\/\?order=:track"\s*status = 301\s*force = true\s*query = \{track = ":track"\}/.exec(toml);
  assert(rule, "redirect rule missing");
  assert(rule.index < toml.indexOf('from = "/order/*"'), "must come before /order/*");
  const order = fs.readFileSync(path.join(ROOT, "frontend/js/order.js"), "utf8");
  assert(/params\.track/.test(order), "order page still reads ?track= too (fallback)");
});

test("repo: the wrong netlify host and /order/?track= links don't come back (github.com URLs are fine)", () => {
  const files = execSync("git ls-files", { cwd: ROOT, encoding: "utf8" }).split("\n").filter(Boolean)
    .filter((f) => !/(^|\/)node_modules\/|package-lock\.json$|\.(png|jpe?g|gif|webp|ico|pdf|woff2?)$/.test(f))
    .filter((f) => f !== "tests/site-url.test.js"); // this file names the patterns it bans
  const bad = [];
  for (const f of files) {
    let text; try { text = fs.readFileSync(path.join(ROOT, f), "utf8"); } catch (e) { continue; }
    text.split("\n").forEach((line, i) => {
      const stripped = line.replace(/https?:\/\/(www\.)?github\.com\/\S*/g, "");
      if (stripped.includes(WRONG_HOST)) bad.push(`${f}:${i + 1}: ${line.trim().slice(0, 100)}`);
      // Old link format: banned where links are built or shown (functions,
      // frontend). Docs/tests may name it (e.g. the LAUNCH smoke test checks the 301).
      if (stripped.includes(OLD_TRACK) && /^(netlify\/functions|frontend)\//.test(f) && !/\/_site-url\.js$/.test(f)) bad.push(`${f}:${i + 1}: ${line.trim().slice(0, 100)}`);
    });
  }
  assert.deepStrictEqual(bad, []);
  // Functions hardcode no *.netlify.app host except the one default.
  const hosts = fs.readdirSync(FN).filter((f) => f.endsWith(".js") && f !== "_site-url.js")
    .filter((f) => /[a-z0-9-]+\.netlify\.app/.test(fs.readFileSync(path.join(FN, f), "utf8")));
  assert.deepStrictEqual(hosts, [], "use DEFAULT_ORIGIN / siteUrl");
});

(async () => {
  let failed = 0;
  for (const [n, f] of tests) { try { await f(); console.log("ok -", n); } catch (e) { failed++; console.error("not ok -", n, "\n ", e.stack); } }
  console.log(failed ? `${failed} failed` : `site-url: ${tests.length} passed`);
  process.exit(failed ? 1 : 0);
})();
