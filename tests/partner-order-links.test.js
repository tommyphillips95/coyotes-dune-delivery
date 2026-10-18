#!/usr/bin/env node
// Partner "Order →" links: wording/accessible names, and the North Padre Island
// partners priced in the existing "Padre Island" zone (not an unknown town).
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const root = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");
const C = require(path.join(root, "frontend/js/coastal.js"));
const Z = require(path.join(root, "netlify/functions/zones.js"));
let failed = 0;
function test(name, fn) { try { fn(); console.log("ok - " + name); } catch (e) { failed++; console.error("not ok - " + name + "\n  " + e.message); } }
const home = read("frontend/index.html");
const decode = (s) => s.replace(/&amp;/g, "&");

test("partner links say 'Order →' with a matching accessible name", () => {
  assert(!/View Menu/.test(home), "no 'View Menu' text left");
  const cards = [...home.matchAll(/<h3>([^<]+)<\/h3>\s*<p class="partner-location">[\s\S]*?<a href="[^"]+" class="partner-link" aria-label="([^"]+)">([^<]+)<\/a>/g)];
  assert.strictEqual(cards.length, 6);
  cards.forEach(([, name, label, text]) => {
    assert.strictEqual(text, "Order →");
    assert.strictEqual(decode(label), "Order from " + decode(name)); // visible "Order" starts the name
  });
});

test("every partner has a pricing town that is a real zone", () => {
  C.PARTNERS.forEach((p) => {
    assert(C.isCity(p.city), p.slug + " city " + p.city);
    assert(Z.ZONES.hubs[p.city], p.slug + " not a pricing hub");
  });
});

test("North Padre Island partners map to the Padre Island zone (beach, 4x4)", () => {
  const npi = [...home.matchAll(/<h3>([^<]+)<\/h3>\s*<p class="partner-location">North Padre Island<\/p>/g)].map((m) => decode(m[1]));
  assert.deepStrictEqual(npi.sort(), ["Padre Island Burger Co.", "Shells Seafood"]);
  npi.forEach((name) => {
    const p = C.PARTNERS.find((x) => x.name === name);
    assert.strictEqual(p.city, "Padre Island", name);
    const q = Z.priceQuote(p.city, p.city, { service_type: "package_delivery" });
    assert.strictEqual(q.beach, true);
    assert.strictEqual(q.requiredClass, "4x4");
  });
  // Why not a new "North Padre Island" town: unknown towns price as a flat 10 mi, no surcharge.
  const unknown = Z.priceQuote("North Padre Island", "North Padre Island", { service_type: "package_delivery" });
  assert.strictEqual(unknown.beach, false);
  assert(!C.isCity("North Padre Island"));
});

test("LAUNCH.md lists all six partners for real pickup addresses", () => {
  const launch = read("LAUNCH.md");
  C.PARTNERS.forEach((p) => assert(launch.includes("`" + p.slug + "`"), p.slug));
});

if (failed) { console.error(failed + " failed"); process.exit(1); }
console.log("partner-order-links tests passed");
