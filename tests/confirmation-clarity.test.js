#!/usr/bin/env node
// Order confirmation: no false "text and email" promise; say "we texted you"
// only when create-order actually sent the SMS; show a booking summary.
// Twilio is mocked (no network); Supabase is the in-memory fake.
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

let fake = null, twilioMode = "ok", smsCalls = 0;
const realLoad = Module._load;
Module._load = function (request) {
  if (request === "@supabase/supabase-js") return { createClient: () => fake };
  if (request === "twilio") return () => ({ messages: { create: async () => { smsCalls++; if (twilioMode === "fail") throw new Error("21608 unverified"); return { sid: "SMmock" }; } } });
  return realLoad.apply(this, arguments);
};
const createOrder = require(path.join(root, "netlify/functions/create-order.js"));
const C = require(path.join(root, "frontend/js/coastal.js"));

const body = () => ({ first_name: "Test", last_name: "Customer", phone: "3615550100", pickup_address: "1 Beach Access Rd", pickup_city: "Port Aransas", pickup_zip: "78373",
  dropoff_address: "Pin 12", dropoff_city: "Mustang Island", dropoff_zip: "78373", service_type: "ride", passenger_count: 1 });
const post = async (b) => { fake = createFakeSupabase({ customers: [], orders: [], order_status_logs: [], sms_logs: [] });
  const r = await createOrder.handler({ httpMethod: "POST", headers: { origin: process.env.SITE_ORIGIN }, body: JSON.stringify(b) });
  return { status: r.statusCode, body: JSON.parse(r.body) }; };
const twilioEnv = (on) => { for (const [k, v] of [["TWILIO_ACCOUNT_SID", "ACmock"], ["TWILIO_AUTH_TOKEN", "mock"], ["TWILIO_PHONE_NUMBER", "+13615550000"]]) { if (on) process.env[k] = v; else delete process.env[k]; } };

const tests = [];
const test = (n, f) => tests.push([n, f]);

test("create-order: smsSent false when Twilio isn't configured", async () => {
  twilioEnv(false); smsCalls = 0;
  const r = await post(body());
  assert.strictEqual(r.status, 201);
  assert.strictEqual(r.body.smsSent, false);
  assert.strictEqual(smsCalls, 0);
});
test("create-order: smsSent true only when the text actually went out", async () => {
  twilioEnv(true); twilioMode = "ok"; smsCalls = 0;
  const ok = await post(body());
  assert.strictEqual(ok.body.smsSent, true); assert.strictEqual(smsCalls, 1);
  twilioMode = "fail";
  const bad = await post(body());
  assert.strictEqual(bad.status, 201, "order still placed when SMS fails");
  assert.strictEqual(bad.body.smsSent, false);
  twilioEnv(false);
});

test("next-steps copy: texted only when smsSent; never promises email", () => {
  const yes = C.confirmationNextSteps({ smsSent: true, phone: "(361) 555-0100" });
  assert(/We texted a confirmation to \(•••\) •••-0100/.test(yes), yes);
  const no = C.confirmationNextSteps({ smsSent: false, phone: "3615550100" });
  assert(!/text/i.test(no.replace(/Track this order/, "")), no);
  [yes, no].forEach((m) => { assert(!/email/i.test(m), m); assert(/Track this order/.test(m)); });
  assert.strictEqual(C.maskPhone("12"), "");
});

test("summary: CT slot formatting, route, pay-later total; no total row when paid", () => {
  assert.strictEqual(C.formatServiceSlot("2026-10-18", "18:30"), "Sun, Oct 18 at 6:30 PM CT");
  assert.strictEqual(C.formatServiceSlot("2026-10-19", "00:05"), "Mon, Oct 19 at 12:05 AM CT");
  assert.strictEqual(C.formatServiceSlot("2026-10-18", "12:00"), "Sun, Oct 18 at 12:00 PM CT");
  assert.strictEqual(C.formatServiceSlot("bad", "18:30"), "");
  const b = { asap: false, date: "2026-10-18", time: "18:30", pickupAddress: "TexMexCoyote", pickupCity: "Port Aransas", dropoffAddress: "Pin 12", dropoffCity: "Mustang Island", amount: 35 };
  assert.deepStrictEqual(C.confirmationSummary(b), [["When", "Sun, Oct 18 at 6:30 PM CT"], ["Pickup", "TexMexCoyote, Port Aransas"], ["Drop-off", "Pin 12, Mustang Island"], ["Estimated total", "$35.00 (pay your driver)"]]);
  assert.deepStrictEqual(C.confirmationSummary(Object.assign({}, b, { paid: true })).map((r) => r[0]), ["When", "Pickup", "Drop-off"]);
  assert.strictEqual(C.confirmationSummary({ asap: true })[0][1], "As soon as possible");
});

test("static: false promise removed; summary rendered with textContent", () => {
  for (const f of ["frontend/order/index.html", "frontend/js/stripe-payment.js", "frontend/js/order.js"]) assert(!/text and email/.test(read(f)), f);
  const html = read("frontend/order/index.html");
  assert(/id="ccConfirmSummary"/.test(html) && /id="ccNextSteps"/.test(html));
  const js = read("frontend/js/order.js");
  const fn = js.slice(js.indexOf("function renderConfirmationDetails"), js.indexOf("function showSuccess"));
  assert(fn.length > 0 && !/innerHTML/.test(fn), "textContent only");
  assert(/smsSent: result\.data\.smsSent === true/.test(js));
});

(async () => {
  let failed = 0;
  for (const [n, f] of tests) { try { await f(); console.log("ok - " + n); } catch (e) { failed++; console.error("not ok - " + n + "\n  " + e.message); } }
  if (failed) { console.error(failed + " failed"); process.exit(1); }
  console.log("confirmation-clarity tests passed");
})();
