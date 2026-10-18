#!/usr/bin/env node
/**
 * POST /api/create-order contract (the one order path; /api/submit-order is an alias).
 * No network: @supabase/supabase-js is swapped for tests/helpers/fake-supabase,
 * Twilio env is unset so no SMS is attempted.
 */
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

test("OPTIONS is 204, GET is 405", async () => {
  currentFake = freshDb();
  assert.strictEqual((await post(undefined, "OPTIONS")).statusCode, 204);
  assert.strictEqual((await post(undefined, "GET")).statusCode, 405);
});

test("400 on missing required fields, nothing written", async () => {
  for (const drop of [["first_name"], ["phone"], ["pickup_address"], ["pickup_city"], ["service_type"]]) {
    currentFake = freshDb();
    const body = base();
    drop.forEach((k) => delete body[k]);
    const res = await post(body);
    assert.strictEqual(res.statusCode, 400, drop.join() + " -> " + res.body);
    assert.ok(JSON.parse(res.body).error);
    assert.strictEqual(currentFake.db.orders.length, 0);
    assert.strictEqual(currentFake.db.customers.length, 0);
  }
});

test("stored estimated_price is the server quote (Port A -> Mustang ride = $35, 4x4)", async () => {
  currentFake = freshDb();
  const res = await post(Object.assign(base(), { estimated_price: 1, total: 1 })); // client price ignored
  assert.strictEqual(res.statusCode, 201, res.body);
  const body = JSON.parse(res.body);
  const row = currentFake.db.orders[0];
  const q = priceQuote("Port Aransas", "Mustang Island", { service_type: "ride", passenger_count: 1 });
  assert.strictEqual(row.estimated_price, q.total);
  assert.strictEqual(row.estimated_price, 35);
  assert.strictEqual(body.estimatedPrice, 35);
  assert.strictEqual(body.miles, q.miles);
  assert.strictEqual(row.required_vehicle_class, "4x4");
  assert.strictEqual(row.status, "pending");
  assert.match(body.orderNumber, /^CDD-[0-9A-Z]+-[0-9A-Z]{1,3}$/);
  assert.strictEqual(currentFake.db.order_status_logs.length, 1);
});

test("missing dropoff city is priced in-town at the pickup city", async () => {
  currentFake = freshDb();
  const b = Object.assign(base(), { pickup_city: "Corpus Christi", pickup_zip: "78401" });
  delete b.dropoff_city; delete b.dropoff_address; delete b.dropoff_zip;
  const res = await post(b);
  assert.strictEqual(res.statusCode, 201, res.body);
  const row = currentFake.db.orders[0];
  assert.strictEqual(row.estimated_price, priceQuote("Corpus Christi", "Corpus Christi", { service_type: "ride", passenger_count: 1 }).total);
  assert.strictEqual(row.dropoff_city, null);
});

test("schedule=later with date+time is stored; otherwise ASAP", async () => {
  currentFake = freshDb();
  await post(Object.assign(base(), { schedule: "later", scheduled_date: FUTURE_DATE, scheduled_time: "09:30" }));
  let row = currentFake.db.orders[0];
  assert.strictEqual(row.is_asap, false);
  assert.strictEqual(row.scheduled_date, FUTURE_DATE);
  assert.strictEqual(row.scheduled_time, "09:30");

  currentFake = freshDb();
  await post(Object.assign(base(), { schedule: "later", scheduled_date: FUTURE_DATE })); // no time
  row = currentFake.db.orders[0];
  assert.strictEqual(row.is_asap, true);
  assert.strictEqual(row.scheduled_date, null);
});

test("chicagoWallClock uses America/Chicago (CDT and CST)", () => {
  assert.strictEqual(V.chicagoWallClock(new Date("2026-10-19T01:00:00Z")), "2026-10-18T20:00"); // CDT, UTC already tomorrow
  assert.strictEqual(V.chicagoWallClock(new Date("2026-12-01T05:30:00Z")), "2026-11-30T23:30"); // CST
});

test("scheduleError: past, bad format, impossible dates, future ok", () => {
  const now = new Date("2026-10-19T01:00:00Z"); // Sun Oct 18 8:00 PM CDT
  assert.match(V.scheduleError("2026-10-18", "19:59", now), /already passed/);
  assert.match(V.scheduleError("2026-10-17", "23:00", now), /already passed/);
  assert.strictEqual(V.scheduleError("2026-10-18", "20:00", now), null);
  assert.strictEqual(V.scheduleError("2026-10-18", "21:15", now), null); // later tonight (UTC date is the 19th)
  assert.strictEqual(V.scheduleError("2026-10-19", "08:00:00", now), null);
  for (const [d, t] of [["10/19/2026", "09:00"], ["2026-10-19", "9am"], ["2026-02-30", "09:00"], ["2026-10-19", "24:00"]]) {
    assert.match(V.scheduleError(d, t, now), /valid date and time/, d + " " + t);
  }
});

test("400 when a scheduled pickup is in the past (Chicago time); nothing written", async () => {
  const [d, t] = chicago(Date.now() - 2 * 3600 * 1000);
  currentFake = freshDb();
  const res = await post(Object.assign(base(), { schedule: "later", scheduled_date: d, scheduled_time: t }));
  assert.strictEqual(res.statusCode, 400, res.body);
  assert.match(JSON.parse(res.body).error, /already passed/);
  assert.strictEqual(currentFake.db.orders.length, 0);
  assert.strictEqual(currentFake.db.customers.length, 0);
});

// ── Explicit time zone: scheduled_at carries its offset ──
test("resolveSchedule: scheduled_at offsets are honored (phone on Pacific is not 'already passed')", () => {
  const now = new Date("2026-10-19T01:00:00Z"); // 8:00 PM CDT = 6:00 PM PDT
  const R = (b) => V.resolveSchedule(Object.assign({ schedule: "later" }, b), now);
  // What the fixed form sends: the Central wall time with the Central offset.
  assert.deepStrictEqual(R({ scheduled_at: "2026-10-18T21:30:00-05:00" }), { date: "2026-10-18", time: "21:30" });
  // A Pacific-offset 7:45 PM is 9:45 PM Central: in the future, stored as Central.
  assert.deepStrictEqual(R({ scheduled_at: "2026-10-18T19:45:00-07:00", scheduled_date: "2026-10-18", scheduled_time: "19:45" }), { date: "2026-10-18", time: "21:45" });
  // The old bug: the same 19:45 with no zone is read as Central and is in the past.
  assert.match(R({ scheduled_date: "2026-10-18", scheduled_time: "19:45" }).error, /already passed/);
  // Z and CST (December) offsets
  assert.deepStrictEqual(R({ scheduled_at: "2026-10-19T03:00:00Z" }), { date: "2026-10-18", time: "22:00" });
  assert.deepStrictEqual(R({ scheduled_at: "2026-12-01T09:00:00-06:00" }), { date: "2026-12-01", time: "09:00" });
  // Really in the past even with the offset
  assert.match(R({ scheduled_at: "2026-10-18T17:59:00-07:00" }).error, /already passed/);
  assert.strictEqual(R({ scheduled_at: "2026-10-18T18:00:00-07:00" }).error, undefined, "now is ok");
  // No offset / garbage / impossible date
  for (const bad of ["2026-10-18T21:30:00", "2026-10-18 21:30-05:00", "tomorrow", "2026-02-30T09:00:00-06:00", "2026-10-18T24:00:00-05:00"]) {
    assert.match(R({ scheduled_at: bad }).error, /valid date and time/, bad);
  }
  assert.deepStrictEqual(V.resolveSchedule({ schedule: "asap", scheduled_at: "2026-10-18T21:30:00-05:00" }, now), { asap: true });
  assert.deepStrictEqual(R({ scheduled_date: "2026-10-19" }), { asap: true }, "date without time still ASAP");
});

test("create-order stores scheduled_at as Central date/time", async () => {
  const at = new Date(Date.now() + 26 * 3600 * 1000);
  const [d, t] = chicago(at.getTime());
  // Send it with a Pacific offset to prove the server converts.
  const pac = new Date(at.getTime() - 7 * 3600 * 1000).toISOString().slice(0, 16) + ":00-07:00";
  currentFake = freshDb();
  const res = await post(Object.assign(base(), { schedule: "later", scheduled_at: pac, scheduled_date: "1999-01-01", scheduled_time: "00:00" }));
  assert.strictEqual(res.statusCode, 201, res.body);
  const row = currentFake.db.orders[0];
  assert.strictEqual(row.is_asap, false);
  assert.strictEqual(row.scheduled_date, d);
  assert.strictEqual(row.scheduled_time, t);
});

test("400 on a malformed ZIP; ZIP+4 and missing optional ZIPs are fine", async () => {
  for (const [field, zip] of [["pickup_zip", "7837"], ["dropoff_zip", "abcde"], ["pickup_zip", "78373 "+"x"]]) {
    currentFake = freshDb();
    const res = await post(Object.assign(base(), { [field]: zip }));
    assert.strictEqual(res.statusCode, 400, field + "=" + zip);
    assert.match(JSON.parse(res.body).error, /5-digit ZIP/);
    assert.strictEqual(currentFake.db.orders.length, 0);
  }
  currentFake = freshDb();
  assert.strictEqual((await post(Object.assign(base(), { pickup_zip: "78373-1234", dropoff_zip: null }))).statusCode, 201);
  currentFake = freshDb();
  const noZip = base(); delete noZip.pickup_zip; delete noZip.dropoff_zip;
  assert.strictEqual((await post(noZip)).statusCode, 201);
});

test("repeat phone reuses the customer row", async () => {
  currentFake = freshDb();
  await post(base());
  await post(Object.assign(base(), { phone: " 3615550100 " }));
  assert.strictEqual(currentFake.db.customers.length, 1);
  assert.strictEqual(currentFake.db.orders.length, 2);
  assert.strictEqual(currentFake.db.orders[0].customer_id, currentFake.db.orders[1].customer_id);
});

test("duplicate customer rows for one phone: no 500, oldest row reused deterministically", async () => {
  currentFake = freshDb();
  currentFake.db.customers.push(
    { id: "cust-new", first_name: "B", last_name: "B", phone: "3615550100", created_at: "2026-09-02T00:00:00Z" },
    { id: "cust-old", first_name: "A", last_name: "A", phone: "3615550100", created_at: "2026-09-01T00:00:00Z" },
  );
  for (let i = 0; i < 2; i++) {
    const res = await post(base());
    assert.strictEqual(res.statusCode, 201, res.body);
  }
  assert.strictEqual(currentFake.db.customers.length, 2, "no third customer row");
  assert.deepStrictEqual(currentFake.db.orders.map((o) => o.customer_id), ["cust-old", "cust-old"]);
});

test("repeat customer is matched by digits: '(361) 555-0100' then '+1 361-555-0100' is one customer", async () => {
  currentFake = freshDb();
  await post(Object.assign(base(), { phone: "(361) 555-0100" }));
  for (const phone of ["+1 361-555-0100", "361.555.0100", "3615550100"]) {
    const res = await post(Object.assign(base(), { phone }));
    assert.strictEqual(res.statusCode, 201, res.body);
  }
  assert.strictEqual(currentFake.db.customers.length, 1);
  assert.strictEqual(currentFake.db.customers[0].phone, "(361) 555-0100", "stored phone unchanged");
  assert.strictEqual(new Set(currentFake.db.orders.map((o) => o.customer_id)).size, 1);
});

test("after the optional phone_normalized migration, lookup uses that column (any stored format)", async () => {
  currentFake = freshDb();
  currentFake.db.customers.push(
    { id: "cust-z", first_name: "Z", last_name: "Z", phone: "361 555 0100 (cell)", phone_normalized: "3615550100", created_at: "2026-09-01T00:00:00Z" },
  );
  const res = await post(Object.assign(base(), { phone: "(361) 555-0100" }));
  assert.strictEqual(res.statusCode, 201, res.body);
  assert.strictEqual(currentFake.db.customers.length, 1);
  assert.strictEqual(currentFake.db.orders[0].customer_id, "cust-z");
});

test("phone_normalized column missing (42703) falls back cleanly; other lookup errors still surface", async () => {
  const hooked = (err) => {
    const fake = freshDb();
    const realFrom = fake.from;
    fake.from = (name) => {
      const b = realFrom(name);
      if (name !== "customers") return b;
      let normalized = false;
      const eq = b.eq, then = b.then;
      b.eq = (c, v) => { if (c === "phone_normalized") normalized = true; return eq(c, v); };
      b.then = (res, rej) => (normalized ? res({ data: null, error: err }) : then(res, rej));
      return b;
    };
    return fake;
  };
  currentFake = hooked({ code: "42703", message: "column customers.phone_normalized does not exist" });
  currentFake.db.customers.push({ id: "cust-1", first_name: "A", last_name: "A", phone: "361-555-0100", created_at: "2026-09-01T00:00:00Z" });
  const ok = await post(base());
  assert.strictEqual(ok.statusCode, 201, ok.body);
  assert.strictEqual(currentFake.db.orders[0].customer_id, "cust-1");

  currentFake = hooked({ code: "08006", message: "connection failure" });
  const origErr = console.error; console.error = () => {};
  let bad;
  try { bad = await post(base()); } finally { console.error = origErr; }
  assert.strictEqual(bad.statusCode, 500);
  assert.strictEqual(currentFake.db.orders.length, 0);
});

test("unique phone index: losing the customer insert race (23505) reuses the winner", async () => {
  currentFake = freshDb();
  const realFrom = currentFake.from;
  let raced = false;
  currentFake.from = (name) => {
    const b = realFrom(name);
    if (name !== "customers") return b;
    const insert = b.insert;
    b.insert = (rows) => {
      if (!raced) {
        raced = true; // another request inserts the same number first
        currentFake.db.customers.push({ id: "cust-winner", first_name: "W", last_name: "W", phone: "361-555-0100", created_at: "2026-09-01T00:00:00Z" });
        b.then = (res) => res({ data: null, error: { code: "23505", message: "duplicate key value violates unique constraint \"customers_phone_normalized_uidx\"" } });
        return b;
      }
      return insert(rows);
    };
    return b;
  };
  const res = await post(base());
  assert.strictEqual(res.statusCode, 201, res.body);
  assert.strictEqual(currentFake.db.customers.length, 1);
  assert.strictEqual(currentFake.db.orders[0].customer_id, "cust-winner");
});

test("returns an order-scoped customer tracking token", async () => {
  currentFake = freshDb();
  const body = JSON.parse((await post(base())).body);
  const claims = jwt.verify(body.trackingToken, SECRET);
  assert.strictEqual(claims.role, "customer");
  assert.strictEqual(claims.order_id, body.orderId);
  assert.strictEqual(claims.order_number, body.orderNumber);
});

test("no SMS attempted or logged when Twilio env is unset", async () => {
  currentFake = freshDb();
  assert.strictEqual((await post(base())).statusCode, 201);
  assert.strictEqual(currentFake.db.sms_logs.length, 0);
});

test("500 does not leak internal database error text", async () => {
  const fake = freshDb();
  const realFrom = fake.from;
  fake.from = (name) => {
    if (name !== "orders") return realFrom(name);
    const b = realFrom(name);
    b.then = (resolve) => resolve({ data: null, error: new Error('duplicate key value violates unique constraint "orders_order_number_key"') });
    return b;
  };
  currentFake = fake;
  const origError = console.error;
  console.error = () => {}; // keep CI log clean; the handler still logs server-side
  let res;
  try { res = await post(base()); } finally { console.error = origError; }
  assert.strictEqual(res.statusCode, 500);
  assert.ok(!/duplicate key|constraint|orders_/.test(res.body), res.body);
  assert.strictEqual(JSON.parse(res.body).error, "Failed to create order");
});

// ── Idempotency: one order per checkout attempt ──
const KEY = "3b0c4f9e-8a51-4d7e-9a3c-1f2e3d4c5b6a";

/** Wrap a fake so orders queries/inserts can be made to fail like real PostgREST. */
function withOrdersHook(fake, hook) {
  const realFrom = fake.from;
  fake.from = (name) => {
    const b = realFrom(name);
    if (name !== "orders") return b;
    const st = { eqs: {}, insert: null };
    const eq = b.eq, insert = b.insert, then = b.then;
    b.eq = (c, v) => { st.eqs[c] = v; return eq(c, v); };
    b.insert = (rows) => { st.insert = rows; return insert(rows); };
    b.then = (res, rej) => {
      const r = hook(st);
      return r ? res(r) : then(res, rej);
    };
    return b;
  };
  return fake;
}

test("same idempotency_key twice -> one order, original returned", async () => {
  currentFake = freshDb();
  const first = await post(Object.assign(base(), { idempotency_key: KEY }));
  assert.strictEqual(first.statusCode, 201, first.body);
  const second = await post(Object.assign(base(), { idempotency_key: KEY }));
  assert.strictEqual(second.statusCode, 200, second.body);
  const a = JSON.parse(first.body), b = JSON.parse(second.body);
  assert.strictEqual(b.replayed, true);
  for (const k of ["orderId", "orderNumber", "estimatedPrice", "miles", "requiredClass", "status"]) assert.deepStrictEqual(b[k], a[k], k);
  assert.strictEqual(jwt.verify(b.trackingToken, SECRET).order_id, a.orderId);
  assert.strictEqual(currentFake.db.orders.length, 1);
  assert.strictEqual(currentFake.db.customers.length, 1);
  assert.strictEqual(currentFake.db.order_status_logs.length, 1, "no second status log");
  assert.strictEqual(currentFake.db.orders[0].idempotency_key, KEY);
});

test("different keys (or no key) create separate orders", async () => {
  currentFake = freshDb();
  await post(Object.assign(base(), { idempotency_key: KEY }));
  await post(Object.assign(base(), { idempotency_key: KEY.replace(/a$/, "b") }));
  await post(base());
  assert.strictEqual(currentFake.db.orders.length, 3);
  assert.strictEqual(currentFake.db.orders[2].idempotency_key, undefined, "no key -> column not set");
});

test("repeated key from a different phone is 409, nothing created", async () => {
  currentFake = freshDb();
  await post(Object.assign(base(), { idempotency_key: KEY }));
  const res = await post(Object.assign(base(), { idempotency_key: KEY, phone: "3615559999" }));
  assert.strictEqual(res.statusCode, 409, res.body);
  assert.ok(!/order_number|orderId|trackingToken/.test(res.body));
  assert.strictEqual(currentFake.db.orders.length, 1);
});

test("malformed idempotency_key is 400", async () => {
  for (const k of ["short", "has spaces in it 1234", "x".repeat(101), "<script>alert(1)</script>"]) {
    currentFake = freshDb();
    const res = await post(Object.assign(base(), { idempotency_key: k }));
    assert.strictEqual(res.statusCode, 400, k);
    assert.strictEqual(currentFake.db.orders.length, 0);
  }
});

test("a retry during a weather hold still returns the order already placed", async () => {
  currentFake = freshDb();
  await post(Object.assign(base(), { idempotency_key: KEY }));
  process.env.WEATHER_SHUTDOWN = "1";
  try {
    const res = await post(Object.assign(base(), { idempotency_key: KEY }));
    assert.strictEqual(res.statusCode, 200, res.body);
    // ...but a new checkout is still refused
    assert.strictEqual((await post(Object.assign(base(), { idempotency_key: KEY + "x" }))).statusCode, 503);
  } finally {
    delete process.env.WEATHER_SHUTDOWN;
  }
});

test("before the migration (no idempotency_key column) orders still go through", async () => {
  const missing = { data: null, error: { code: "42703", message: 'column orders.idempotency_key does not exist' } };
  currentFake = withOrdersHook(freshDb(), (st) => {
    if ("idempotency_key" in st.eqs) return missing;
    if (st.insert && st.insert[0] && "idempotency_key" in st.insert[0]) return missing;
    return null;
  });
  const origWarn = console.warn; console.warn = () => {};
  let res;
  try { res = await post(Object.assign(base(), { idempotency_key: KEY })); } finally { console.warn = origWarn; }
  assert.strictEqual(res.statusCode, 201, res.body);
  assert.strictEqual(currentFake.db.orders.length, 1);
  assert.strictEqual(currentFake.db.orders[0].idempotency_key, undefined);
});

test("concurrent duplicate (unique violation on insert) returns the winning order", async () => {
  const fake = freshDb();
  // The other request already inserted this key; our first lookup missed it.
  fake.db.customers.push({ id: "c-win", phone: "3615550100", first_name: "Test", last_name: "Customer" });
  const winner = { id: "o-win", order_number: "CDD-WIN-1", customer_id: "c-win", idempotency_key: KEY, service_type: "ride",
    pickup_city: "Port Aransas", dropoff_city: "Mustang Island", passenger_count: 1, estimated_price: 35, required_vehicle_class: "4x4", status: "pending" };
  let lookups = 0;
  currentFake = withOrdersHook(fake, (st) => {
    if ("idempotency_key" in st.eqs) { lookups++; return { data: lookups === 1 ? null : Object.assign({}, winner), error: null }; }
    if (st.insert) return { data: null, error: { code: "23505", message: 'duplicate key value violates unique constraint "orders_idempotency_key_uidx"' } };
    return null;
  });
  const res = await post(Object.assign(base(), { idempotency_key: KEY }));
  assert.strictEqual(res.statusCode, 200, res.body);
  const body = JSON.parse(res.body);
  assert.strictEqual(body.orderId, "o-win");
  assert.strictEqual(body.replayed, true);
});

test("reused key with a different order payload is refused (422), nothing created", async () => {
  currentFake = freshDb();
  const first = await post(Object.assign(base(), { idempotency_key: KEY }));
  assert.strictEqual(first.statusCode, 201);
  assert.match(currentFake.db.orders[0].idempotency_payload_hash, /^[0-9a-f]{64}$/);
  for (const change of [{ dropoff_city: "Padre Island" }, { passenger_count: 3 }, { special_instructions: "Gate 4" }, { service_type: "package_delivery", package_size: "large" }]) {
    const res = await post(Object.assign(base(), { idempotency_key: KEY }, change));
    assert.strictEqual(res.statusCode, 422, JSON.stringify(change) + " " + res.body);
    const body = JSON.parse(res.body);
    assert.ok(/changed after it was sent/.test(body.error));
    assert.ok(!/order|CDD-|token/i.test(JSON.stringify(Object.keys(body))) && !body.orderId && !body.trackingToken);
  }
  assert.strictEqual(currentFake.db.orders.length, 1);
});

test("payload hash ignores whitespace/phone formatting/email case and missing-vs-empty", async () => {
  const h = createOrder._validation.orderPayloadHash;
  const a = base();
  const b = Object.assign(base(), { phone: "(361) 555-0100", first_name: " Test ", email: null, passenger_count: "1" });
  a.email = "";
  assert.strictEqual(h(a), h(b));
  assert.strictEqual(h(Object.assign(base(), { email: "T@X.com" })), h(Object.assign(base(), { email: "t@x.com " })));
  assert.notStrictEqual(h(base()), h(Object.assign(base(), { pickup_zip: "78418" })));
  // Formatting-only differences still replay over HTTP
  currentFake = freshDb();
  await post(Object.assign(base(), { idempotency_key: KEY }));
  const res = await post(Object.assign(base(), { idempotency_key: KEY, phone: "361-555-0100", pickup_address: "1 Beach Access Rd  " }));
  assert.strictEqual(res.statusCode, 200, res.body);
});

test("legacy keyed row without a hash still replays for the same phone", async () => {
  currentFake = freshDb();
  await post(Object.assign(base(), { idempotency_key: KEY }));
  delete currentFake.db.orders[0].idempotency_payload_hash;
  const res = await post(Object.assign(base(), { idempotency_key: KEY, special_instructions: "x" }));
  assert.strictEqual(res.statusCode, 200, res.body);
});

test("race winner with a different payload is refused, not returned", async () => {
  const fake = freshDb();
  fake.db.customers.push({ id: "c-win", phone: "3615550100" });
  const winner = { id: "o-win", order_number: "CDD-WIN-2", customer_id: "c-win", idempotency_key: KEY, service_type: "ride",
    pickup_city: "Port Aransas", dropoff_city: "Padre Island", passenger_count: 1, estimated_price: 40, status: "pending",
    idempotency_payload_hash: createOrder._validation.orderPayloadHash(Object.assign(base(), { dropoff_city: "Padre Island" })) };
  let lookups = 0;
  currentFake = withOrdersHook(fake, (st) => {
    if ("idempotency_key" in st.eqs) { lookups++; return { data: lookups === 1 ? null : Object.assign({}, winner), error: null }; }
    if (st.insert) return { data: null, error: { code: "23505", message: "duplicate key" } };
    return null;
  });
  const res = await post(Object.assign(base(), { idempotency_key: KEY }));
  assert.strictEqual(res.statusCode, 422, res.body);
  assert.ok(!res.body.includes("CDD-WIN-2"));
});

test("hash column missing (partial migration): insert retried without both idempotency columns", async () => {
  const missing = { data: null, error: { code: "PGRST204", message: "Could not find the 'idempotency_payload_hash' column of 'orders'" } };
  currentFake = withOrdersHook(freshDb(), (st) => (st.insert && st.insert[0] && "idempotency_payload_hash" in st.insert[0] ? missing : null));
  const origWarn = console.warn; console.warn = () => {};
  let res;
  try { res = await post(Object.assign(base(), { idempotency_key: KEY })); } finally { console.warn = origWarn; }
  assert.strictEqual(res.statusCode, 201, res.body);
  assert.strictEqual(currentFake.db.orders[0].idempotency_payload_hash, undefined);
});

test("order form resends the frozen payload on retry; edits drop it", () => {
  const src = require("fs").readFileSync(path.join(__dirname, "..", "frontend/js/order.js"), "utf8");
  assert.ok(/CoyoteAPI\.post\('\/api\/create-order', attemptPayload\(orderData\)[,)]/.test(src));
  assert.ok(/function resetCheckoutKey[\s\S]{0,200}checkoutPayload = null/.test(src));
  const sql = require("fs").readFileSync(path.join(__dirname, "..", "schema/order_idempotency.sql"), "utf8");
  assert.ok(/ADD COLUMN IF NOT EXISTS idempotency_payload_hash TEXT/.test(sql));
});

test("order form sends one key per attempt and reuses it on retry", () => {
  const fs = require("fs");
  const src = fs.readFileSync(path.join(__dirname, "..", "frontend/js/order.js"), "utf8");
  assert.ok(/idempotency_key: checkoutIdempotencyKey\(\)/.test(src), "orderData carries the key");
  assert.ok(/if \(!checkoutKey\) checkoutKey = newIdempotencyKey\(\)/.test(src), "key is created once and reused");
  assert.ok(/if \(result\.ok\) \{\s*checkoutKey = null;/.test(src), "success clears it");
  assert.ok(/form\.addEventListener\('input', resetCheckoutKey\)/.test(src), "edits start a new attempt");
  assert.ok(/randomUUID/.test(src));
  // The failure branches must not clear the key (that is what makes retry safe).
  const fail = src.slice(src.indexOf("} else {", src.indexOf("if (result.ok) {")), src.indexOf("const trackBtn"));
  assert.ok(!/checkoutKey = null/.test(fail), "failure keeps the key for the retry");
  const sql = fs.readFileSync(path.join(__dirname, "..", "schema/order_idempotency.sql"), "utf8");
  assert.ok(/ADD COLUMN IF NOT EXISTS idempotency_key TEXT/.test(sql));
  assert.ok(/CREATE UNIQUE INDEX IF NOT EXISTS orders_idempotency_key_uidx[\s\S]*WHERE idempotency_key IS NOT NULL/.test(sql));
});

test("LAUNCH.md step 5 pastes exactly schema/order_idempotency.sql, and every statement is re-runnable", () => {
  const fs = require("fs");
  const root = path.join(__dirname, "..");
  const sql = fs.readFileSync(path.join(root, "schema/order_idempotency.sql"), "utf8");
  const statements = sql.split("\n").filter((l) => !/^\s*--/.test(l)).join("\n").split(";").map((t) => t.trim()).filter(Boolean);
  assert.strictEqual(statements.length, 3);
  for (const st of statements) assert.ok(/IF NOT EXISTS/.test(st), "re-runnable: " + st.split("\n")[0]);
  assert.ok(/ADD COLUMN IF NOT EXISTS idempotency_payload_hash TEXT/.test(sql));
  const md = fs.readFileSync(path.join(root, "LAUNCH.md"), "utf8");
  const section = md.split("### Step 5 on Supabase")[1];
  assert.ok(section, "LAUNCH.md has the Step 5 section");
  const blocks = [...section.split("\n### ")[0].matchAll(/```sql\n([\s\S]*?)```/g)].map((m) => m[1].trim());
  assert.strictEqual(blocks[0], sql.trim(), "pasted SQL matches the file");
  assert.ok(/SQL Editor/.test(section));
  for (const want of ["idempotency_key", "idempotency_payload_hash", "orders_idempotency_key_uidx"]) assert.ok(blocks[1].includes(want), "verify query checks " + want);
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
  console.log("create-order: " + tests.length + " passed");
})();
