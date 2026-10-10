#!/usr/bin/env node
/**
 * Zone pricing edge cases (#7). Plain node, no deps.
 * Server = netlify/functions/zones.js (what create-order charges).
 * Client = frontend/js/zones.js (what the customer sees).
 */
const assert = require("assert");
const path = require("path");

const server = require(path.join(__dirname, "..", "netlify/functions/zones.js"));
const clientMod = require(path.join(__dirname, "..", "frontend/js/zones.js"));
const client = clientMod.CoyoteZones;

const CITIES = ["Port Aransas", "Mustang Island", "Padre Island", "Corpus Christi", "Rockport"];
const BEACH = new Set(["Port Aransas", "Mustang Island", "Padre Island"]);
const SERVICES = ["ride", "package_delivery", "grocery_run", "group_transport"];
const OPTS = [
  {}, { passenger_count: 1 }, { passenger_count: 4 }, { passenger_count: "3" }, { passenger_count: "abc" },
  { package_size: "small" }, { package_size: "large" }, { package_size: "oversized" },
];

let passed = 0;
function test(name, fn) { fn(); passed++; console.log("  ok - " + name); }
const cents = (n) => Math.round(n * 100) === n * 100 || Math.abs(Math.round(n * 100) - n * 100) < 1e-6;

console.log("zones-edge.test.js");

test("rate/mileage tables are identical front and back", () => {
  assert.deepStrictEqual(clientMod.ZONES.miles, server.ZONES.miles);
  assert.deepStrictEqual(clientMod.ZONES.rates, server.ZONES.rates);
  for (const k of ["beachSurcharge", "extraPassenger", "packageLarge", "packageOversized"]) {
    assert.strictEqual(clientMod.ZONES[k], server.ZONES[k], k);
  }
  assert.deepStrictEqual(clientMod.ZONES.hubs.filter((h) => h.beach).map((h) => h.name).sort(), [...server.ZONES.beachCities].sort());
});

test("front and back agree for every city pair × service × option", () => {
  let n = 0;
  for (const a of CITIES) for (const b of CITIES) for (const service_type of SERVICES) for (const o of OPTS) {
    const opts = Object.assign({ service_type }, o);
    const s = server.priceQuote(a, b, opts);
    const c = client.priceQuote(a, b, opts);
    for (const k of ["total", "miles", "beach", "requiredClass", "base", "perMile", "beachSurcharge", "extraPassenger", "packageAdd"]) {
      assert.strictEqual(c[k], s[k], `${a}->${b} ${JSON.stringify(opts)} ${k}`);
    }
    n++;
  }
  assert.strictEqual(n, 25 * 4 * OPTS.length);
});

test("reversed pairs are symmetric (miles, beach, class, total)", () => {
  for (const a of CITIES) for (const b of CITIES) {
    const ab = server.priceQuote(a, b), ba = server.priceQuote(b, a);
    assert.strictEqual(ab.miles, ba.miles, `${a}<->${b}`);
    assert.strictEqual(ab.total, ba.total, `${a}<->${b}`);
    assert.strictEqual(ab.requiredClass, ba.requiredClass);
  }
});

test("same-city pairs use the short in-town table", () => {
  const expect = { "Port Aransas": 4, "Mustang Island": 4, "Padre Island": 5, "Corpus Christi": 6, Rockport: 5 };
  for (const c of CITIES) {
    assert.strictEqual(server.milesBetween(c, c), expect[c], c);
    assert.strictEqual(server.milesBetween(c, ""), expect[c], c + " with blank dropoff");
    assert.strictEqual(server.milesBetween(c, undefined), expect[c]);
  }
});

test("pairs missing from the table fall back to hub distance, rounded to 0.1 mi", () => {
  for (const [a, b] of [["Rockport", "Padre Island"], ["Rockport", "Mustang Island"]]) {
    const m = server.milesBetween(a, b);
    assert.ok(m > 10 && m < 45, `${a}-${b} ${m}`);
    assert.strictEqual(Math.round(m * 10) / 10, m);
    assert.strictEqual(client.milesBetween(a, b), m);
  }
});

test("unknown cities price at the 10 mi default without a beach surcharge", () => {
  for (const [a, b] of [["Atlantis", "Atlantis"], ["Atlantis", "Corpus Christi"], ["", ""], [null, null]]) {
    const s = server.priceQuote(a, b);
    assert.strictEqual(s.miles, 10);
    assert.strictEqual(s.beach, false);
    assert.strictEqual(s.total, 12 + 10 * 2.5);
    assert.strictEqual(client.priceQuote(a, b).total, s.total);
  }
  // A beach city on either end still triggers sand access.
  const s = server.priceQuote("Atlantis", "Port Aransas");
  assert.strictEqual(s.beach, true);
  assert.strictEqual(s.requiredClass, "4x4");
  assert.strictEqual(s.total, 12 + 25 + 8);
});

test("beach surcharge on for any beach end, off otherwise", () => {
  for (const a of CITIES) for (const b of CITIES) {
    const s = server.priceQuote(a, b);
    const beach = BEACH.has(a) || BEACH.has(b);
    assert.strictEqual(s.beach, beach);
    assert.strictEqual(s.beachSurcharge, beach ? 8 : 0);
    assert.strictEqual(s.requiredClass, beach ? "4x4" : "2wd");
    assert.strictEqual(server.requiredClass(a, b), s.requiredClass);
  }
  assert.strictEqual(server.priceQuote("Corpus Christi", "Rockport").beachSurcharge, 0);
  assert.strictEqual(server.priceQuote("Corpus Christi", "Padre Island").beachSurcharge, 8);
});

test("totals are rounded to cents", () => {
  for (const a of CITIES) for (const b of CITIES) for (const service_type of SERVICES) {
    const t = server.priceQuote(a, b, { service_type }).total;
    assert.ok(cents(t), `${a}->${b} ${service_type} ${t}`);
  }
  // Fallback distance gives fractional miles: 19.9 mi × $2.50 = 49.75 → total 69.75
  const r = server.priceQuote("Rockport", "Mustang Island");
  assert.strictEqual(r.miles, 19.9);
  assert.strictEqual(r.total, 69.75);
  // grocery: 18 + 19.9 × 1.5 = 47.85 (+8 beach) = 55.85, float-safe
  assert.strictEqual(server.priceQuote("Rockport", "Mustang Island", { service_type: "grocery_run" }).total, 55.85);
});

test("passenger and package add-ons", () => {
  const base = server.priceQuote("Corpus Christi", "Corpus Christi").total; // 12 + 6×2.5 = 27
  assert.strictEqual(base, 27);
  assert.strictEqual(server.priceQuote("Corpus Christi", "Corpus Christi", { passenger_count: 4 }).total, 27 + 9);
  assert.strictEqual(server.priceQuote("Corpus Christi", "Corpus Christi", { passenger_count: "abc" }).total, 27);
  assert.strictEqual(server.priceQuote("Corpus Christi", "Corpus Christi", { passenger_count: 0 }).total, 27);
  const pkg = (size) => server.priceQuote("Corpus Christi", "Corpus Christi", { service_type: "package_delivery", package_size: size }).total;
  assert.strictEqual(pkg("small"), 27);
  assert.strictEqual(pkg("large"), 27 + 8);
  assert.strictEqual(pkg("oversized"), 27 + 15);
});

test("unknown service type falls back to ride rates", () => {
  const s = server.priceQuote("Corpus Christi", "Corpus Christi", { service_type: "jetpack" });
  assert.strictEqual(s.total, 27);
  assert.strictEqual(client.priceQuote("Corpus Christi", "Corpus Christi", { service_type: "jetpack" }).total, 27);
});

console.log(`zones-edge: ${passed} passed`);
