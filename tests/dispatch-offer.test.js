#!/usr/bin/env node
/**
 * Dispatch + offer unit tests (#7). Stubbed Supabase, no network, plain node.
 *  - offerNext: nearest eligible driver, beach 4x4/utv/awd rule, skip
 *    already-offered/declined, clean "no_drivers", re-offer after expiry,
 *    90s OFFER_SECONDS window.
 *  - respond-offer handler: 403 wrong driver, 409 not offered, expired →
 *    409 + next offer, accept and decline paths.
 */
const assert = require("assert");
const path = require("path");
const Module = require("module");
const { createFakeSupabase } = require("./helpers/fake-supabase");

// Twilio must never be reached; no TWILIO_* env means sendSMS short-circuits.
delete process.env.TWILIO_ACCOUNT_SID;
delete process.env.TWILIO_AUTH_TOKEN;
delete process.env.TWILIO_PHONE_NUMBER;

// Route @supabase/supabase-js createClient to the current fake.
let currentFake = null;
const realLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "@supabase/supabase-js") return { createClient: () => currentFake };
  return realLoad.apply(this, arguments);
};

const FN = path.join(__dirname, "..", "netlify/functions");
const dispatch = require(path.join(FN, "dispatch.js"));
const respondOffer = require(path.join(FN, "respond-offer.js"));

const PA = [27.8339, -97.0611]; // Port Aransas hub
const CC = [27.8006, -97.3964]; // Corpus Christi hub

function order(over) {
  return Object.assign({
    id: "o1", order_number: "CDD-1", pickup_city: "Port Aransas", dropoff_city: "Mustang Island",
    pickup_lat: PA[0], pickup_lng: PA[1], status: "pending", payment_status: "paid",
    customer_id: "c1", driver_id: null,
  }, over);
}
function driver(id, cls, over) {
  return Object.assign({ id, first_name: id, last_name: "D", phone: null, vehicle_class: cls, online: true, status: "approved" }, over);
}
function loc(driverId, lat, lng, ts) {
  return { driver_id: driverId, lat, lng, timestamp: ts || "2026-10-10T12:00:00Z" };
}
const offers = (fake) => fake.db.dispatch_offers || [];

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

// ── offerNext ──
test("haversineMi: ~0 for same point, symmetric", () => {
  assert.ok(dispatch.haversineMi(PA[0], PA[1], PA[0], PA[1]) < 1e-9);
  const ab = dispatch.haversineMi(PA[0], PA[1], CC[0], CC[1]);
  const ba = dispatch.haversineMi(CC[0], CC[1], PA[0], PA[1]);
  assert.ok(Math.abs(ab - ba) < 1e-9 && ab > 15 && ab < 30, String(ab));
});

test("chooses the nearest eligible online driver", async () => {
  const fake = createFakeSupabase({
    orders: [order({ pickup_city: "Corpus Christi", dropoff_city: "Corpus Christi", pickup_lat: CC[0], pickup_lng: CC[1] })],
    applications: [driver("far", "2wd"), driver("near", "2wd"), driver("offline", "2wd", { online: false }), driver("pending", "2wd", { status: "pending" })],
    driver_locations: [loc("far", PA[0], PA[1]), loc("near", CC[0] + 0.01, CC[1]), loc("offline", CC[0], CC[1]), loc("pending", CC[0], CC[1])],
  });
  const r = await dispatch.offerNext(fake, "o1");
  assert.strictEqual(r.offered, true);
  assert.strictEqual(r.driverId, "near");
  assert.strictEqual(r.requiredClass, "2wd");
  assert.strictEqual(offers(fake).length, 1);
  assert.strictEqual(offers(fake)[0].status, "offered");
});

test("uses each driver's latest location", async () => {
  const fake = createFakeSupabase({
    orders: [order()],
    applications: [driver("a", "4x4"), driver("b", "4x4")],
    driver_locations: [
      loc("a", CC[0], CC[1], "2026-10-10T12:05:00Z"), loc("a", PA[0], PA[1], "2026-10-10T11:00:00Z"),
      loc("b", PA[0] + 0.05, PA[1], "2026-10-10T12:00:00Z"),
    ],
  });
  const r = await dispatch.offerNext(fake, "o1");
  assert.strictEqual(r.driverId, "b"); // a's newest ping is in Corpus, far from PA
});

test("beach pickup or dropoff requires 4x4/utv/awd", async () => {
  for (const [pick, drop] of [["Port Aransas", "Corpus Christi"], ["Corpus Christi", "Padre Island"]]) {
    for (const cls of ["4x4", "utv", "awd", "AWD"]) {
      const fake = createFakeSupabase({
        orders: [order({ pickup_city: pick, dropoff_city: drop })],
        applications: [driver("car", "2wd"), driver("sedan", null), driver("beachy", cls)],
        driver_locations: [loc("car", PA[0], PA[1]), loc("sedan", PA[0], PA[1]), loc("beachy", CC[0], CC[1])],
      });
      const r = await dispatch.offerNext(fake, "o1");
      assert.strictEqual(r.requiredClass, "4x4");
      assert.strictEqual(r.driverId, "beachy", `${pick}->${drop} ${cls}`);
      assert.strictEqual(r.beach, true);
    }
  }
});

test("non-beach route accepts any vehicle class", async () => {
  const fake = createFakeSupabase({
    orders: [order({ pickup_city: "Rockport", dropoff_city: "Corpus Christi", pickup_lat: null, pickup_lng: null })],
    applications: [driver("car", "2wd")],
    driver_locations: [loc("car", 28.02, -97.05)],
  });
  const r = await dispatch.offerNext(fake, "o1");
  assert.strictEqual(r.driverId, "car");
  assert.strictEqual(r.requiredClass, "2wd");
  assert.strictEqual(r.beach, false);
});

test("skips drivers already offered or who declined", async () => {
  const fake = createFakeSupabase({
    orders: [order()],
    applications: [driver("d1", "4x4"), driver("d2", "4x4"), driver("d3", "4x4")],
    driver_locations: [loc("d1", PA[0], PA[1]), loc("d2", PA[0] + 0.01, PA[1]), loc("d3", PA[0] + 0.2, PA[1])],
    dispatch_offers: [
      { id: "x1", order_id: "o1", driver_id: "d1", status: "declined", expires_at: "2026-01-01T00:00:00Z" },
      { id: "x2", order_id: "o1", driver_id: "d2", status: "expired", expires_at: "2026-01-01T00:00:00Z" },
    ],
  });
  const r = await dispatch.offerNext(fake, "o1");
  assert.strictEqual(r.driverId, "d3");
});

test("no eligible driver gives a clean no_drivers result and a hold log", async () => {
  const fake = createFakeSupabase({
    orders: [order()],
    applications: [driver("car", "2wd")],
    driver_locations: [loc("car", PA[0], PA[1])],
  });
  const r = await dispatch.offerNext(fake, "o1");
  assert.deepStrictEqual(r, { offered: false, reason: "no_drivers", requiredClass: "4x4" });
  assert.strictEqual(offers(fake).length, 0);
  assert.ok(/No online 4x4 driver/.test(fake.db.order_status_logs[0].note));
});

test("guards: missing order, already assigned, closed, open offer", async () => {
  const none = createFakeSupabase({});
  assert.strictEqual((await dispatch.offerNext(none, "nope")).reason, "order_missing");
  const assigned = createFakeSupabase({ orders: [order({ driver_id: "d9" })] });
  assert.strictEqual((await dispatch.offerNext(assigned, "o1")).reason, "already_assigned");
  for (const status of ["cancelled", "completed"]) {
    const closed = createFakeSupabase({ orders: [order({ status })] });
    assert.strictEqual((await dispatch.offerNext(closed, "o1")).reason, "order_closed");
  }
  const future = new Date(Date.now() + 60000).toISOString();
  const open = createFakeSupabase({
    orders: [order()], applications: [driver("d1", "4x4")],
    dispatch_offers: [{ id: "live", order_id: "o1", driver_id: "d1", status: "offered", expires_at: future }],
  });
  const r = await dispatch.offerNext(open, "o1");
  assert.deepStrictEqual(r, { offered: false, reason: "offer_open", offerId: "live" });
});

test("an expired offer is expired and the order re-offered to the next driver", async () => {
  const past = new Date(Date.now() - 1000).toISOString();
  const fake = createFakeSupabase({
    orders: [order()],
    applications: [driver("d1", "4x4"), driver("d2", "4x4")],
    driver_locations: [loc("d1", PA[0], PA[1]), loc("d2", PA[0] + 0.05, PA[1])],
    dispatch_offers: [{ id: "old", order_id: "o1", driver_id: "d1", status: "offered", expires_at: past }],
  });
  const r = await dispatch.offerNext(fake, "o1");
  assert.strictEqual(fake.db.dispatch_offers.find((o) => o.id === "old").status, "expired");
  assert.strictEqual(r.offered, true);
  assert.strictEqual(r.driverId, "d2");
});

test("offers last exactly OFFER_SECONDS (90s)", async () => {
  assert.strictEqual(dispatch.OFFER_SECONDS, 90);
  const realNow = Date.now;
  const T = Date.parse("2026-10-10T13:00:00.000Z");
  Date.now = () => T;
  try {
    const fake = createFakeSupabase({ orders: [order()], applications: [driver("d1", "4x4")] });
    const r = await dispatch.offerNext(fake, "o1");
    assert.strictEqual(Date.parse(r.expiresAt) - T, 90000);
    assert.strictEqual(offers(fake)[0].expires_at, "2026-10-10T13:01:30.000Z");
    assert.strictEqual(offers(fake)[0].distance_mi, 999); // no location ping → sorted last, still offered
  } finally {
    Date.now = realNow;
  }
});

test("expireStale: only offers past expires_at expire", async () => {
  const fake = createFakeSupabase({
    dispatch_offers: [
      { id: "past", order_id: "o1", status: "offered", expires_at: new Date(Date.now() - 1).toISOString() },
      { id: "future", order_id: "o2", status: "offered", expires_at: new Date(Date.now() + 5000).toISOString() },
      { id: "done", order_id: "o3", status: "accepted", expires_at: new Date(Date.now() - 5000).toISOString() },
    ],
  });
  const stale = await dispatch.expireStale(fake);
  assert.deepStrictEqual(stale.map((s) => s.id), ["past"]);
  const st = Object.fromEntries(fake.db.dispatch_offers.map((o) => [o.id, o.status]));
  assert.deepStrictEqual(st, { past: "expired", future: "offered", done: "accepted" });
});

// ── respond-offer handler ──
async function respond(fake, body) {
  currentFake = fake;
  const res = await respondOffer.handler({ httpMethod: "POST", headers: {}, body: JSON.stringify(body) });
  return { status: res.statusCode, body: JSON.parse(res.body || "{}") };
}
function offerSeed(over, extra) {
  return Object.assign({
    orders: [order()],
    customers: [{ id: "c1", phone: null }],
    applications: [driver("d1", "4x4"), driver("d2", "4x4")],
    driver_locations: [loc("d1", PA[0], PA[1]), loc("d2", PA[0] + 0.05, PA[1])],
    dispatch_offers: [Object.assign({ id: "of1", order_id: "o1", driver_id: "d1", status: "offered", expires_at: new Date(Date.now() + 60000).toISOString() }, over)],
  }, extra);
}

test("respond-offer: method and input validation", async () => {
  currentFake = createFakeSupabase({});
  assert.strictEqual((await respondOffer.handler({ httpMethod: "GET", headers: {} })).statusCode, 405);
  assert.strictEqual((await respondOffer.handler({ httpMethod: "OPTIONS", headers: {} })).statusCode, 204);
  assert.strictEqual((await respond(createFakeSupabase({}), { offer_id: "of1", driver_id: "d1", action: "maybe" })).status, 400);
  assert.strictEqual((await respond(createFakeSupabase({}), { offer_id: "nope", driver_id: "d1", action: "accept" })).status, 404);
});

test("respond-offer: wrong driver → 403", async () => {
  const fake = createFakeSupabase(offerSeed());
  const r = await respond(fake, { offer_id: "of1", driver_id: "d2", action: "accept" });
  assert.strictEqual(r.status, 403);
  assert.strictEqual(fake.db.dispatch_offers[0].status, "offered");
});

test("respond-offer: offer not in offered state → 409", async () => {
  for (const status of ["accepted", "declined", "expired"]) {
    const fake = createFakeSupabase(offerSeed({ status }));
    const r = await respond(fake, { offer_id: "of1", driver_id: "d1", action: "accept" });
    assert.strictEqual(r.status, 409);
    assert.strictEqual(r.body.error, "offer already " + status);
  }
});

test("respond-offer: expired offer → 409 expired + next offer", async () => {
  const fake = createFakeSupabase(offerSeed({ expires_at: new Date(Date.now() - 1000).toISOString() }));
  const r = await respond(fake, { offer_id: "of1", driver_id: "d1", action: "accept" });
  assert.strictEqual(r.status, 409);
  assert.strictEqual(r.body.error, "offer expired");
  assert.strictEqual(r.body.next.offered, true);
  assert.strictEqual(r.body.next.driverId, "d2");
  assert.strictEqual(fake.db.dispatch_offers.find((o) => o.id === "of1").status, "expired");
  assert.strictEqual(fake.db.orders[0].driver_id, null);
});

test("respond-offer: decline → declined + next offer to another driver", async () => {
  const fake = createFakeSupabase(offerSeed());
  const r = await respond(fake, { offer_id: "of1", driver_id: "d1", action: "DECLINE" });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.action, "declined");
  assert.strictEqual(r.body.next.driverId, "d2");
  assert.strictEqual(fake.db.dispatch_offers.find((o) => o.id === "of1").status, "declined");
});

test("respond-offer: accept assigns the order and logs it", async () => {
  const fake = createFakeSupabase(offerSeed());
  const r = await respond(fake, { offer_id: "of1", driver_id: "d1", action: "accept" });
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(r.body, { success: true, action: "accepted", orderId: "o1" });
  assert.strictEqual(fake.db.dispatch_offers[0].status, "accepted");
  assert.strictEqual(fake.db.orders[0].driver_id, "d1");
  assert.strictEqual(fake.db.orders[0].status, "assigned");
  assert.strictEqual(fake.db.order_status_logs.at(-1).status, "assigned");
});

test("respond-offer: accept on an already-assigned order → 409, offer expired", async () => {
  const fake = createFakeSupabase(offerSeed({}, { orders: [order({ driver_id: "someone" })] }));
  const r = await respond(fake, { offer_id: "of1", driver_id: "d1", action: "accept" });
  assert.strictEqual(r.status, 409);
  assert.strictEqual(r.body.error, "order already assigned");
  assert.strictEqual(fake.db.dispatch_offers[0].status, "expired");
  assert.strictEqual(fake.db.orders[0].driver_id, "someone");
});

(async () => {
  let failed = 0;
  console.log("dispatch-offer.test.js");
  for (const [name, fn] of tests) {
    try { await fn(); console.log("  ok - " + name); }
    catch (e) { failed++; console.error("  FAIL - " + name + "\n    " + (e.stack || e.message)); }
  }
  Module._load = realLoad;
  if (failed) { console.error(`dispatch-offer: ${failed} failed`); process.exit(1); }
  console.log(`dispatch-offer: ${tests.length} passed`);
})();
