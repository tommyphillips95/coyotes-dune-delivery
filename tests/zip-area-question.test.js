#!/usr/bin/env node
// ZIP 78418 + Corpus Christi: island or Flour Bluff? Server requires the
// answer (<end>_zip_area), prices "island" as Padre Island, and the client
// quote matches. No network; Supabase is the in-memory fake.
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const Module = require("module");
const { createFakeSupabase } = require("./helpers/fake-supabase");

const root = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");
for (const k of ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_PHONE_NUMBER", "WEATHER_SHUTDOWN", "COYOTE_WEATHER_HOLD"]) delete process.env[k];
process.env.SUPABASE_URL = "http://example.invalid";
process.env.SUPABASE_SERVICE_KEY = "test";
process.env.SITE_ORIGIN = "https://coyote-dune-delivery.netlify.app";
process.env.JWT_SECRET = "test-secret-at-least-16";
let fake = null;
const realLoad = Module._load;
Module._load = function (request) {
  if (request === "@supabase/supabase-js") return { createClient: () => fake };
  return realLoad.apply(this, arguments);
};
const createOrder = require(path.join(root, "netlify/functions/create-order.js"));
const { priceQuote } = require(path.join(root, "netlify/functions/zones.js"));
const C = require(path.join(root, "frontend/js/coastal.js"));
const clientZones = require(path.join(root, "frontend/js/zones.js")).CoyoteZones;
const area = require(path.join(root, "netlify/functions/_service-area.js"));

const CC78418 = { pickup_city: "Corpus Christi", pickup_zip: "78418", dropoff_city: "Corpus Christi", dropoff_zip: "78401" };
const base = (o) => Object.assign({ first_name: "Test", last_name: "Customer", phone: "3615550100", service_type: "ride", passenger_count: 1,
  pickup_address: "1 Test St", dropoff_address: "2 Test St" }, CC78418, o || {});
async function post(b) {
  fake = createFakeSupabase({ customers: [], orders: [], order_status_logs: [], sms_logs: [] });
  const r = await createOrder.handler({ httpMethod: "POST", headers: { origin: process.env.SITE_ORIGIN }, body: JSON.stringify(b) });
  return { status: r.statusCode, body: JSON.parse(r.body), db: fake.db };
}
const ride = { service_type: "ride", passenger_count: 1 };
const tests = [];
const test = (n, f) => tests.push([n, f]);

test("no answer -> 400 zip_area_required naming the end; nothing written", async () => {
  const p = await post(base());
  assert.strictEqual(p.status, 400, JSON.stringify(p.body));
  assert.strictEqual(p.body.code, "zip_area_required");
  assert.strictEqual(p.body.field, "pickup_zip_area");
  assert.strictEqual(p.body.zip, "78418");
  assert(/Padre Island and Flour Bluff/.test(p.body.error), p.body.error);
  assert.strictEqual(p.db.orders.length, 0);
  const d = await post(base({ pickup_zip: "78401", dropoff_zip: "78418", pickup_zip_area: "island" }));
  assert.strictEqual(d.status, 400); assert.strictEqual(d.body.field, "dropoff_zip_area");
  const bad = await post(base({ pickup_zip_area: "beach" }));
  assert.strictEqual(bad.status, 400); assert.strictEqual(bad.body.code, "zip_area_required");
});

test("'island' -> priced and dispatched as Padre Island (surcharge + 4x4), whatever town was picked", async () => {
  const r = await post(base({ pickup_zip_area: "island" }));
  assert.strictEqual(r.status, 201, JSON.stringify(r.body));
  const row = r.db.orders[0];
  const want = priceQuote("Padre Island", "Corpus Christi", ride);
  assert(want.beach && want.beachSurcharge > 0);
  assert.strictEqual(row.estimated_price, want.total);
  assert.strictEqual(r.body.estimatedPrice, want.total);
  assert.notStrictEqual(want.total, priceQuote("Corpus Christi", "Corpus Christi", ride).total);
  assert.strictEqual(row.required_vehicle_class, "4x4");
  assert.strictEqual(row.pickup_city, "Padre Island");
  assert.strictEqual(row.dropoff_city, "Corpus Christi");
  assert(/said it is on Padre Island/.test(r.db.order_status_logs[0].note), r.db.order_status_logs[0].note);
});

test("'mainland' -> Corpus Christi pricing, normal vehicle (no forced 4x4)", async () => {
  const r = await post(base({ pickup_zip_area: "mainland" }));
  assert.strictEqual(r.status, 201, JSON.stringify(r.body));
  const row = r.db.orders[0];
  assert.strictEqual(row.estimated_price, priceQuote("Corpus Christi", "Corpus Christi", ride).total);
  assert.strictEqual(row.required_vehicle_class, "2wd");
  assert.strictEqual(row.pickup_city, "Corpus Christi");
  assert(/Flour Bluff/.test(r.db.order_status_logs[0].note));
  assert(!/forceBeach/.test(read("netlify/functions/create-order.js") + read("netlify/functions/_service-area.js")));
});

test("answer is ignored where the ZIP isn't ambiguous for that town", async () => {
  for (const o of [{ pickup_zip: "78411", pickup_zip_area: "island" }, { pickup_city: "Padre Island", pickup_zip_area: "mainland" }]) {
    const r = await post(base(o));
    assert.strictEqual(r.status, 201, JSON.stringify(o));
    const town = o.pickup_city || "Corpus Christi";
    assert.strictEqual(r.db.orders[0].estimated_price, priceQuote(town, "Corpus Christi", ride).total, JSON.stringify(o));
  }
});

test("client quote = server price for every answer, service and end", async () => {
  assert.deepStrictEqual(C.ZIP_AREAS, area.ZIP_AREAS);
  const cases = [
    [{ pickup_zip_area: "island" }, "Padre Island", "Corpus Christi"],
    [{ pickup_zip_area: "mainland" }, "Corpus Christi", "Corpus Christi"],
    [{ pickup_zip: "78401", dropoff_zip: "78418", dropoff_zip_area: "island" }, "Corpus Christi", "Padre Island"],
    [{ dropoff_zip: "78418", pickup_zip_area: "island", dropoff_zip_area: "island" }, "Padre Island", "Padre Island"],
    [{ pickup_city: "Rockport", pickup_zip: "78382", dropoff_zip: "78418", dropoff_zip_area: "island" }, "Rockport", "Padre Island"],
  ];
  for (const svc of [{ service_type: "ride", passenger_count: 3 }, { service_type: "package_delivery", package_size: "large", passenger_count: null }]) {
    for (const [o, pTown, dTown] of cases) {
      const b = base(Object.assign({}, svc, o));
      const r = await post(b);
      assert.strictEqual(r.status, 201, JSON.stringify(o) + JSON.stringify(r.body));
      const cp = C.zipAreaTown(b.pickup_city, b.pickup_zip, b.pickup_zip_area);
      const cd = C.zipAreaTown(b.dropoff_city, b.dropoff_zip, b.dropoff_zip_area);
      assert.deepStrictEqual([cp, cd], [pTown, dTown], JSON.stringify(o));
      const client = clientZones.priceQuote(cp, cd, svc);
      assert.strictEqual(client.total, r.body.estimatedPrice, JSON.stringify(o));
      assert.strictEqual(client.requiredClass, r.body.requiredClass, JSON.stringify(o));
    }
  }
  assert.strictEqual(C.zipAreaQuestion("Corpus Christi", "78418-1234").zip, "78418");
  assert.strictEqual(C.zipAreaQuestion("Padre Island", "78418"), null);
  assert.strictEqual(C.zipAreaQuestion("Corpus Christi", "78411"), null);
});

test("idempotency hash: answer counts when sent; old hashes (no answer) unchanged", () => {
  const h = createOrder._validation.orderPayloadHash;
  const b = base();
  assert.strictEqual(h(b), h(Object.assign({}, b, { pickup_zip_area: null, dropoff_zip_area: "" })));
  assert.notStrictEqual(h(Object.assign({}, b, { pickup_zip_area: "island" })), h(Object.assign({}, b, { pickup_zip_area: "mainland" })));
});

test("order page: accessible radio question on Review, sent with the order, server code reopens it", () => {
  const html = read("frontend/order/index.html");
  const review = html.slice(html.indexOf('data-step="5"'), html.indexOf('id="submitBtn"'));
  for (const end of ["pickup", "dropoff"]) {
    const g = review.slice(review.indexOf(`id="${end}ZipAreaGroup"`) - 40, review.indexOf("</fieldset>", review.indexOf(`id="${end}ZipAreaGroup"`)));
    assert(/<fieldset class="cc-zip-area"/.test(g) && /<legend>Where is your/.test(g), end);
    assert(new RegExp(`aria-describedby="${end}ZipAreaHelp ${end}ZipAreaError"`).test(g), end);
    assert(new RegExp(`type="radio" name="${end}ZipArea" value="island"`).test(g) && new RegExp(`name="${end}ZipArea" value="mainland"`).test(g), end);
  }
  const js = read("frontend/js/order.js");
  assert(/pickup_zip_area: zipAreaAnswer\('pickup'\)/.test(js) && /dropoff_zip_area: zipAreaAnswer\('dropoff'\)/.test(js));
  assert(/zip_area_required/.test(js) && /unansweredZipAreas\(\)/.test(js));
  assert(/const pickupCity = pricedTown\('pickup', assume\)/.test(js), "client quote must price the answered town");
  const css = read("frontend/css/coastal.css");
  assert(/\.cc-zip-area-option \{[^}]*min-height: 48px/.test(css));
});

(async () => {
  let failed = 0;
  for (const [n, f] of tests) { try { await f(); console.log("ok - " + n); } catch (e) { failed++; console.error("not ok - " + n + "\n  " + e.message); } }
  if (failed) { console.error(failed + " failed"); process.exit(1); }
  console.log("zip-area-question tests passed");
})();
