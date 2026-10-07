#!/usr/bin/env node
/**
 * Prove the on-screen estimate (frontend/js/zones.js) equals create-order
 * pricing (netlify/functions/zones.js priceQuote).
 *
 * Cases:
 *   1. Port Aransas → Mustang Island, ride, 1 passenger (beach + $8 sand)
 *   2. Corpus Christi → Corpus Christi, ride, 1 passenger (in-town, no sand)
 */
const assert = require("assert");
const path = require("path");

const server = require(path.join(__dirname, "..", "netlify/functions/zones.js"));
const clientMod = require(path.join(__dirname, "..", "frontend/js/zones.js"));
const client = clientMod.CoyoteZones;

const cases = [
  {
    name: "Port A → Mustang ride",
    pickup: "Port Aransas",
    dropoff: "Mustang Island",
    opts: { service_type: "ride", passenger_count: 1 },
    expect: { miles: 6, beach: true, requiredClass: "4x4", total: 35 },
  },
  {
    name: "Corpus in-town ride",
    pickup: "Corpus Christi",
    dropoff: "Corpus Christi",
    opts: { service_type: "ride", passenger_count: 1 },
    expect: { miles: 6, beach: false, requiredClass: "2wd", total: 27 },
  },
];

let failed = 0;
for (const c of cases) {
  const screen = client.priceQuote(c.pickup, c.dropoff, c.opts);
  const createOrder = server.priceQuote(c.pickup, c.dropoff, c.opts);
  try {
    assert.strictEqual(screen.miles, createOrder.miles, c.name + " miles client!=server");
    assert.strictEqual(screen.total, createOrder.total, c.name + " total client!=server");
    assert.strictEqual(screen.beach, createOrder.beach, c.name + " beach flag");
    assert.strictEqual(screen.requiredClass, createOrder.requiredClass, c.name + " class");
    assert.strictEqual(screen.miles, c.expect.miles, c.name + " miles");
    assert.strictEqual(screen.beach, c.expect.beach, c.name + " beach");
    assert.strictEqual(screen.requiredClass, c.expect.requiredClass, c.name + " class expect");
    assert.strictEqual(screen.total, c.expect.total, c.name + " total");
    console.log("PASS", c.name, "$" + screen.total.toFixed(2), screen.miles + "mi", screen.requiredClass);
  } catch (err) {
    failed += 1;
    console.error("FAIL", c.name, err.message);
    console.error("  screen", screen);
    console.error("  server", createOrder);
  }
}

if (failed) {
  process.exit(1);
}
console.log("quote parity ok — client estimate == create-order price");
