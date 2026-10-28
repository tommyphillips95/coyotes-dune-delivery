#!/usr/bin/env node
/**
 * Issue #13: weather shutdown gate + create-order persists required_vehicle_class.
 */
const assert = require("assert");
const path = require("path");
const Module = require("module");
const { createFakeSupabase } = require("./helpers/fake-supabase");

delete process.env.TWILIO_ACCOUNT_SID;
delete process.env.TWILIO_AUTH_TOKEN;
delete process.env.TWILIO_PHONE_NUMBER;
delete process.env.WEATHER_SHUTDOWN;
delete process.env.COYOTE_WEATHER_HOLD;
delete process.env.WEATHER_SHUTDOWN_REASON;

let currentFake = null;
const realLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "@supabase/supabase-js") return { createClient: () => currentFake };
  return realLoad.apply(this, arguments);
};

const FN = path.join(__dirname, "..", "netlify/functions");
const weather = require(path.join(FN, "_weather.js"));
const dispatch = require(path.join(FN, "dispatch.js"));
const createOrder = require(path.join(FN, "create-order.js"));

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test("weatherShutdownActive reads WEATHER_SHUTDOWN", () => {
  assert.strictEqual(weather.weatherShutdownActive({}), false);
  assert.strictEqual(weather.weatherShutdownActive({ WEATHER_SHUTDOWN: "1" }), true);
  assert.strictEqual(weather.weatherShutdownActive({ WEATHER_SHUTDOWN: "true" }), true);
  assert.strictEqual(weather.weatherShutdownActive({ COYOTE_WEATHER_HOLD: "yes" }), true);
  assert.strictEqual(weather.weatherShutdownActive({ WEATHER_SHUTDOWN: "0" }), false);
});

test("offerNext refuses when weather_hold on order", async () => {
  currentFake = createFakeSupabase({
    orders: [{
      id: "o1", order_number: "CDD-1", pickup_city: "Port Aransas", dropoff_city: "Mustang Island",
      pickup_lat: 27.83, pickup_lng: -97.06, status: "pending", payment_status: "paid",
      customer_id: "c1", driver_id: null, weather_hold: true, required_vehicle_class: "4x4",
    }],
    applications: [{ id: "d1", first_name: "A", last_name: "D", phone: null, vehicle_class: "4x4", online: true, status: "approved" }],
    driver_locations: [{ driver_id: "d1", lat: 27.83, lng: -97.06, timestamp: "2026-10-13T12:00:00Z" }],
  });
  const r = await dispatch.offerNext(currentFake, "o1");
  assert.strictEqual(r.offered, false);
  assert.strictEqual(r.reason, "weather_hold");
});

test("offerNext refuses when WEATHER_SHUTDOWN env is on", async () => {
  process.env.WEATHER_SHUTDOWN = "1";
  try {
    currentFake = createFakeSupabase({
      orders: [{
        id: "o1", order_number: "CDD-1", pickup_city: "Corpus Christi", dropoff_city: "Corpus Christi",
        pickup_lat: 27.8, pickup_lng: -97.4, status: "pending", payment_status: "paid",
        customer_id: "c1", driver_id: null, weather_hold: false,
      }],
      applications: [{ id: "d1", first_name: "A", last_name: "D", phone: null, vehicle_class: "2wd", online: true, status: "approved" }],
      driver_locations: [{ driver_id: "d1", lat: 27.8, lng: -97.4, timestamp: "2026-10-13T12:00:00Z" }],
    });
    const r = await dispatch.offerNext(currentFake, "o1");
    assert.strictEqual(r.offered, false);
    assert.strictEqual(r.reason, "weather_hold");
  } finally {
    delete process.env.WEATHER_SHUTDOWN;
  }
});

test("create-order returns 503 under weather shutdown", async () => {
  process.env.WEATHER_SHUTDOWN = "1";
  process.env.WEATHER_SHUTDOWN_REASON = "Tropical storm hold";
  process.env.SUPABASE_URL = "http://example.invalid";
  process.env.SUPABASE_SERVICE_KEY = "test";
  process.env.JWT_SECRET = "test-secret-at-least-16";
  try {
    currentFake = createFakeSupabase({ customers: [], orders: [], order_status_logs: [], sms_logs: [] });
    const res = await createOrder.handler({
      httpMethod: "POST",
      headers: { origin: "https://coyote-dune-delivery.netlify.app" },
      body: JSON.stringify({
        first_name: "T", last_name: "P", phone: "3615550100",
        pickup_address: "1 Beach", pickup_city: "Port Aransas",
        dropoff_city: "Mustang Island", service_type: "package_delivery",
      }),
    });
    assert.strictEqual(res.statusCode, 503);
    const body = JSON.parse(res.body);
    assert.strictEqual(body.error, "weather_hold");
    assert.strictEqual(body.weather_hold, true);
    assert.match(body.message, /Tropical storm hold/);
  } finally {
    delete process.env.WEATHER_SHUTDOWN;
    delete process.env.WEATHER_SHUTDOWN_REASON;
  }
});

test("create-order persists required_vehicle_class", async () => {
  process.env.SUPABASE_URL = "http://example.invalid";
  process.env.SUPABASE_SERVICE_KEY = "test";
  process.env.JWT_SECRET = "test-secret-at-least-16";
  process.env.SITE_ORIGIN = "https://coyote-dune-delivery.netlify.app";
  currentFake = createFakeSupabase({ customers: [], orders: [], order_status_logs: [], sms_logs: [] });
  const res = await createOrder.handler({
    httpMethod: "POST",
    headers: { origin: "https://coyote-dune-delivery.netlify.app" },
    body: JSON.stringify({
      first_name: "T", last_name: "P", phone: "3615550101",
      pickup_address: "1 Beach", pickup_city: "Port Aransas",
      dropoff_city: "Mustang Island", service_type: "package_delivery",
    }),
  });
  assert.strictEqual(res.statusCode, 201, res.body);
  const inserted = currentFake.db.orders[0];
  assert.ok(inserted, "order inserted");
  assert.strictEqual(inserted.required_vehicle_class, "4x4");
  assert.strictEqual(inserted.weather_hold, false);
  const body = JSON.parse(res.body);
  assert.strictEqual(body.requiredClass, "4x4");
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
  console.log(tests.length + " passed");
})();
