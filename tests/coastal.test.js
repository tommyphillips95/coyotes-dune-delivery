#!/usr/bin/env node
/**
 * Coastal Coyote (#22) regression checks.
 *  - Route planner shows the same total create-order will charge.
 *  - /order/ deep-link params are whitelisted.
 *  - Search/category entry points map onto real services.
 *  - Tracking-token store is bounded and order-scoped.
 *  - Static guards for the checkout/tracking reliability fixes.
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");

// Browser-style globals: zones.js then coastal.js attach to `global`.
global.window = global;
const server = require(path.join(ROOT, "netlify/functions/zones.js"));
global.CoyoteZones = require(path.join(ROOT, "frontend/js/zones.js")).CoyoteZones;
const C = require(path.join(ROOT, "frontend/js/coastal.js"));

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log("  ok - " + name);
}

console.log("coastal.test.js");

test("planRoute total equals server priceQuote for every city pair/service", () => {
  const opts = [
    ["ride", { passenger_count: 1 }],
    ["ride", { passenger_count: 6 }],
    ["package_delivery", { package_size: "small" }],
    ["package_delivery", { package_size: "large" }],
  ];
  for (const a of C.CITIES) for (const b of C.CITIES) for (const [svc, o] of opts) {
    const plan = C.planRoute(a, b, svc, o);
    const s = server.priceQuote(a, b, Object.assign({ service_type: svc }, o));
    assert.ok(plan, `plan ${a}->${b}`);
    assert.strictEqual(plan.total, s.total, `${a}->${b} ${svc} ${JSON.stringify(o)}`);
    assert.strictEqual(plan.totalText, "$" + s.total.toFixed(2));
    assert.strictEqual(plan.beach, s.beach);
  }
});

test("planRoute rejects unknown cities", () => {
  assert.strictEqual(C.planRoute("Atlantis", "Port Aransas", "ride"), null);
});

test("Port A -> Mustang ride is $35 with beach access (matches quote-parity)", () => {
  const p = C.planRoute("Port Aransas", "Mustang Island", "ride", { passenger_count: 1 });
  assert.strictEqual(p.total, 35);
  assert.strictEqual(p.requiredClass, "4x4");
});

test("every category maps to a service the order form offers", () => {
  const html = read("frontend/order/index.html");
  for (const cat of C.CATEGORIES) {
    assert.ok(C.SERVICES[cat.service], cat.id);
    assert.ok(html.includes(`value="${cat.service}"`), `order form offers ${cat.service}`);
  }
});

test("matchCategory routes search text", () => {
  assert.strictEqual(C.matchCategory("live shrimp bait"), "bait");
  assert.strictEqual(C.matchCategory("tacos"), "food");
  assert.strictEqual(C.matchCategory("bag of ice"), "groceries");
  assert.strictEqual(C.matchCategory("sunscreen"), "essentials");
  assert.strictEqual(C.matchCategory("airport ride"), "rides");
  assert.strictEqual(C.matchCategory(""), null);
});

test("buildOrderUrl -> parseOrderParams round-trips known values", () => {
  const url = C.buildOrderUrl({ category: "bait", pickup: "Port Aransas", dropoff: "Mustang Island", q: "live shrimp" });
  assert.ok(url.startsWith("/order/?"));
  const p = C.parseOrderParams(url.slice(url.indexOf("?")));
  assert.strictEqual(p.category, "bait");
  assert.strictEqual(p.service, "package_delivery");
  assert.strictEqual(p.pickup, "Port Aransas");
  assert.strictEqual(p.dropoff, "Mustang Island");
  assert.strictEqual(p.q, "live shrimp");
});

test("parseOrderParams drops unknown or hostile input", () => {
  const p = C.parseOrderParams("?service=admin&category=<script>&pickup=Nowhere&track=../../etc&q=" + "x".repeat(500));
  assert.strictEqual(p.service, null);
  assert.strictEqual(p.category, null);
  assert.strictEqual(p.pickup, null);
  assert.strictEqual(p.track, null);
  assert.ok(!p.q || p.q.length <= 120);
  assert.strictEqual(C.parseOrderParams("?order=cdd-20261009-ab12").track, "CDD-20261009-AB12");
});

test("tracking tokens are per-order, bounded to 10, clearable", () => {
  const mem = {};
  const store = { getItem: (k) => (k in mem ? mem[k] : null), setItem: (k, v) => { mem[k] = String(v); }, removeItem: (k) => { delete mem[k]; } };
  for (let i = 0; i < 12; i++) C.saveTrackingToken("CDD-" + (1000 + i), "tok" + i, store);
  assert.strictEqual(Object.keys(JSON.parse(mem.cdd_tracking_tokens)).length, 10);
  assert.strictEqual(C.getTrackingToken("cdd-1011", store), "tok11");
  C.clearTrackingToken("CDD-1011", store);
  assert.strictEqual(C.getTrackingToken("CDD-1011", store), null);
  assert.strictEqual(C.buildTrackUrl("cdd-1"), "/track/?order=CDD-1");
});

test("terminal statuses stop tracking", () => {
  assert.ok(C.isTerminalStatus("completed"));
  assert.ok(C.isTerminalStatus("cancelled"));
  assert.ok(!C.isTerminalStatus("in_progress"));
});

// ── Static regression guards ──
test("order page loads zones.js + coastal.js before order.js and offers Mustang Island", () => {
  const html = read("frontend/order/index.html");
  const z = html.indexOf("js/zones.js"), c = html.indexOf("js/coastal.js"), o = html.indexOf("js/order.js");
  assert.ok(z > -1 && c > z && o > c, "script order");
  assert.ok((html.match(/value="Mustang Island"/g) || []).length >= 2);
});

test("checkout creates the order once (no cloned form, no duplicate submit)", () => {
  const stripe = read("frontend/js/stripe-payment.js");
  assert.ok(!/cloneNode/.test(stripe), "stripe-payment.js must not clone the form");
  assert.ok(/CoyoteCheckout/.test(stripe));
  const main = read("frontend/js/main.js");
  assert.ok(!/fetch\([^)]*submit-order/.test(main) && !/addEventListener\(\s*['"]submit['"]/.test(main), "main.js must not post orders");
  const home = read("frontend/index.html");
  assert.ok(!/id="orderForm"/.test(home), "home page must not carry a client-priced order form");
  const order = read("frontend/js/order.js");
  assert.ok(/submitting/.test(order), "order.js has an in-flight guard");
});

test("tracking refreshes status, guards overlap, and sends the token", () => {
  const t = read("frontend/track/track.js");
  assert.ok(/if \(polling \|\| !currentToken\) return/.test(t));
  assert.ok(/isTerminal\(/.test(t));
  assert.ok(/removeLayer\(pickupMarker\)/.test(t));
  assert.ok(/Authorization: "Bearer "/.test(t));
  const html = read("frontend/track/index.html");
  assert.ok(html.indexOf("js/coastal.js") < html.indexOf("track.js"));
});

test("every page loads the coastal design system", () => {
  for (const p of ["index.html", "order/index.html", "track/index.html", "driver/index.html", "admin/index.html", "apply/index.html"]) {
    assert.ok(read("frontend/" + p).includes("css/coastal.css"), p);
  }
});

console.log(`coastal: ${passed} passed`);
