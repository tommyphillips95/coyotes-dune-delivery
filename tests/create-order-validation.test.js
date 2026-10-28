#!/usr/bin/env node
/** create-order input validation: bad JSON, blank text, unknown service, passenger count, tip. */
const assert = require("assert");
const path = require("path");
const Module = require("module");
const jwt = require("jsonwebtoken");
const { createFakeSupabase } = require("./helpers/fake-supabase");

for (const k of ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_PHONE_NUMBER", "WEATHER_SHUTDOWN", "COYOTE_WEATHER_HOLD", "WEATHER_SHUTDOWN_REASON"]) {
  delete process.env[k];
}
process.env.SUPABASE_URL = "http://example.invalid";
process.env.SUPABASE_SERVICE_KEY = "test";
process.env.SITE_ORIGIN = "https://coyote-dune-delivery.netlify.app";
const SECRET = "test-secret-at-least-16";
process.env.JWT_SECRET = SECRET;

let currentFake = null;
const realLoad = Module._load;
Module._load = function (request) {
  if (request === "@supabase/supabase-js") return { createClient: () => currentFake };
  return realLoad.apply(this, arguments);
};

const FN = path.join(__dirname, "..", "netlify/functions");
const createOrder = require(path.join(FN, "create-order.js"));
const { priceQuote } = require(path.join(FN, "zones.js"));
const V = createOrder._validation;
// Chicago wall-clock date/time for an instant (dates in tests are relative to now).
const chicago = (ms) => V.chicagoWallClock(new Date(ms)).split("T");
const [FUTURE_DATE] = chicago(Date.now() + 36 * 3600 * 1000);

const freshDb = () => createFakeSupabase({ customers: [], orders: [], order_status_logs: [], sms_logs: [] });
const base = () => ({
  first_name: "Test", last_name: "Customer", phone: "3615550100",
  pickup_address: "1 Beach Access Rd", pickup_city: "Port Aransas", pickup_zip: "78373",
  dropoff_address: "Pin 12", dropoff_city: "Mustang Island", dropoff_zip: "78373",
  service_type: "ride", passenger_count: 1,
});
const post = (body, method) => createOrder.handler({
  httpMethod: method || "POST",
  headers: { origin: process.env.SITE_ORIGIN },
  body: body === undefined ? undefined : JSON.stringify(body),
});

const tests = [];
const test = (name, fn) => tests.push([name, fn]);


const fs = require("fs");
const is400 = (res, re, field) => {
  assert.strictEqual(res.statusCode, 400, res.body);
  const b = JSON.parse(res.body);
  assert.ok(re.test(b.error), b.error);
  assert.ok(b.error.length < 80 && !/JSON|token|position|undefined/i.test(b.error), b.error);
  if (field) assert.strictEqual(b.field, field);
  assert.strictEqual(currentFake.db.orders.length, 0);
  assert.strictEqual(currentFake.db.customers.length, 0);
};
const raw = (s) => createOrder.handler({ httpMethod: "POST", headers: { origin: process.env.SITE_ORIGIN }, body: s });

test("body that isn't valid JSON (or isn't an object) is 400 with a plain message", async () => {
  for (const s of ["{not json", "[1,2]", "null", "\"hi\""]) {
    currentFake = freshDb();
    is400(await raw(s), /couldn't read that order/i);
  }
});

test("names, phone and pickup address that are only spaces are 400, naming the field", async () => {
  for (const [f, field] of [["first_name", "first_name"], ["last_name", "last_name"], ["phone", "phone"], ["pickup_address", "pickup_address"]]) {
    currentFake = freshDb();
    is400(await post(Object.assign(base(), { [f]: "   \t " })), /required/, field);
  }
});

test("text is stored trimmed; optional text that is only spaces is stored as empty (null)", async () => {
  currentFake = freshDb();
  const res = await post(Object.assign(base(), {
    first_name: "  Ana ", last_name: " Ruiz  ", pickup_address: "  1 Beach Access Rd  ",
    dropoff_address: "   ", package_description: "  ", special_instructions: " Gate code 12 ",
  }));
  assert.strictEqual(res.statusCode, 201, res.body);
  const c = currentFake.db.customers[0], o = currentFake.db.orders[0];
  assert.strictEqual(c.first_name, "Ana");
  assert.strictEqual(c.last_name, "Ruiz");
  assert.strictEqual(o.pickup_address, "1 Beach Access Rd");
  assert.strictEqual(o.dropoff_address, null);
  assert.strictEqual(o.package_description, null);
  assert.strictEqual(o.special_instructions, "Gate code 12");
});

test("unknown service type is 400; only ride and package_delivery are accepted", async () => {
  for (const t of ["delivery", "jetpack", "RIDE", "grocery_run"]) {
    currentFake = freshDb();
    is400(await post(Object.assign(base(), { service_type: t })), /ride or a package/, "service_type");
  }
});

test("passenger count that isn't a whole number >= 1 is 400", async () => {
  for (const n of ["abc", "2x", 1.5, -1, 0, true, {}]) {
    currentFake = freshDb();
    is400(await post(Object.assign(base(), { passenger_count: n })), /passengers/, "passenger_count");
  }
});

test("negative or non-numeric tip is 400", async () => {
  for (const t of [-1, "-0.5", "abc", "Infinity"]) {
    currentFake = freshDb();
    is400(await post(Object.assign(base(), { tip_amount: t })), /Tip/, "tip_amount");
  }
});

test("zero, blank and missing tip are fine (stored as 0); a positive tip is kept", async () => {
  for (const [t, want] of [[0, 0], ["0", 0], ["", 0], [null, 0], [undefined, 0], ["2.50", 2.5], [5, 5]]) {
    currentFake = freshDb();
    const res = await post(Object.assign(base(), { tip_amount: t }));
    assert.strictEqual(res.statusCode, 201, t + " " + res.body);
    assert.strictEqual(currentFake.db.orders[0].tip_amount, want);
  }
});

// Mirrors order.js placeOrder(): every combination the form can produce.
const clientOrder = (o) => Object.assign({
  first_name: "Test", last_name: "Customer", phone: "(361) 555-0100", email: null,
  service_type: "ride", pickup_address: "1 Beach Access Rd", pickup_city: "Port Aransas", pickup_zip: null,
  dropoff_address: null, dropoff_city: null, dropoff_zip: null, pickup_zip_area: null, dropoff_zip_area: null,
  schedule: "asap", scheduled_date: null, scheduled_time: null, scheduled_at: null,
  passenger_count: 1, package_size: null, package_description: null, special_instructions: null,
}, o);

test("every order the real form can send still goes through", async () => {
  const cases = [];
  for (const n of [1, 2, 3, 4]) cases.push({ passenger_count: n });
  for (const size of ["small", "medium", "large", "oversized"]) cases.push({ service_type: "package_delivery", passenger_count: null, package_size: size, package_description: "Cooler" });
  cases.push({ email: "a@b.co", pickup_zip: "78373", dropoff_address: "Pin 12", dropoff_city: "Mustang Island", dropoff_zip: "78373", special_instructions: "Blue cooler" });
  cases.push({ schedule: "later", scheduled_date: FUTURE_DATE, scheduled_time: "10:00" });
  cases.push({ idempotency_key: "chk_" + "a".repeat(24) });
  for (const c of cases) {
    currentFake = freshDb();
    const res = await post(clientOrder(c));
    assert.strictEqual(res.statusCode, 201, JSON.stringify(c) + " -> " + res.body);
  }
});

test("package order with passenger_count null stores 1 and prices as a package", async () => {
  currentFake = freshDb();
  const res = await post(clientOrder({ service_type: "package_delivery", passenger_count: null, package_size: "small" }));
  assert.strictEqual(res.statusCode, 201, res.body);
  assert.strictEqual(currentFake.db.orders[0].passenger_count, 1);
  const q = priceQuote("Port Aransas", "Port Aransas", { service_type: "package_delivery", package_size: "small" });
  assert.strictEqual(currentFake.db.orders[0].estimated_price, q.total);
});

test("order page highlights the field the server names and shows its message", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "frontend/js/order.js"), "utf8");
  const m = /const SERVER_FIELDS = \{([^}]*)\}/.exec(src);
  for (const [f, id] of [["first_name", "customerFirstName"], ["last_name", "customerLastName"], ["phone", "customerPhone"], ["pickup_address", "pickupAddress"]]) {
    assert.ok(new RegExp(f + ": '" + id + "'").test(m[1]), f);
  }
  const html = fs.readFileSync(path.join(__dirname, "..", "frontend/order/index.html"), "utf8");
  for (const v of ["ride", "package_delivery"]) assert.ok(html.includes('name="serviceType" value="' + v + '"'), v);
  assert.strictEqual((html.match(/name="serviceType"/g) || []).length, 2, "form offers a service the server would refuse");
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
  console.log("create-order-validation: " + tests.length + " passed");
})();
