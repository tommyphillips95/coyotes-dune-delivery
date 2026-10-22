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

test("isValidZip accepts 5-digit / ZIP+4 and rejects junk", () => {
  for (const ok of ["78373", " 78418 ", "78373-1234", "783731234"]) assert.ok(C.isValidZip(ok), ok);
  for (const bad of ["", null, undefined, "7837", "783735", "abcde", "78373-12", "Port A"]) assert.ok(!C.isValidZip(bad), String(bad));
});

test("order form mobile inputs: numeric ZIP keypad, 16px fields, labelled tracking inputs", () => {
  const html = read("frontend/order/index.html");
  for (const id of ["pickupZip", "dropoffZip"]) {
    const tag = (html.match(new RegExp('<input[^>]*id="' + id + '"[^>]*>')) || [""])[0];
    assert.ok(/inputmode="numeric"/.test(tag), id + " numeric keypad");
    assert.ok(/pattern="/.test(tag), id + " pattern");
  }
  assert.ok(/\.tracking-form input \{ font-size: 16px; \}/.test(html), "no iOS focus zoom");
  assert.ok(/min-height: 44px/.test(html), "44px tap targets");
  assert.ok(/id="trackOrderNumber"[^>]*aria-label=/.test(html));
  assert.ok(/id="trackPhone"[^>]*aria-label=/.test(html));
  const order = read("frontend/js/order.js");
  assert.ok(/isValidZip\(el\.value\)/.test(order), "route step validates ZIP format");
  assert.ok(/aria-invalid/.test(order), "errors set aria-invalid");
});

test("pickup/dropoff Swap stays visible on mobile with a 44px target", () => {
  const html = read("frontend/order/index.html");
  const mobile = html.slice(html.indexOf("@media (max-width: 768px)"), html.indexOf("</style>"));
  assert.ok(!/\.route-connector\s*\{\s*display:\s*none/.test(mobile), "route-connector must not be hidden on mobile");
  assert.ok(/\.route-swap\s*\{[^}]*min-height:\s*44px/.test(mobile), "swap has a 44px min-height");
  assert.ok(/id="swapLocations"[^>]*aria-label=/.test(html));
  // Programmatic .value swaps fire no change events; the live quote must refresh.
  assert.ok(/swapLocations\(\); updateLiveQuote\(\);/.test(read("frontend/js/order.js")));
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

test("footers show the current year (2026 fallback, main.js keeps it current)", () => {
  for (const p of ["index.html", "order/index.html"]) {
    const html = read("frontend/" + p);
    assert.ok(/<span data-current-year>2026<\/span> Coyote's Dune Delivery/.test(html), p);
    assert.ok(!/>\s*20(24|25) Coyote's/.test(html), p + " stale year");
  }
  assert.ok(read("frontend/404.html").includes("&copy; 2026"));
  assert.ok(/\[data-current-year\][\s\S]{0,120}getFullYear\(\)/.test(read("frontend/js/main.js")));
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

test("CoyoteAPI surfaces a 4xx body's error text so validation messages reach the page", () => {
  const main = read("frontend/js/main.js");
  assert.ok(/new Error\(\(data && \(data\.message \|\| data\.error\)\) \|\| 'Request failed'\)/.test(main));
  // create-order 400s use { error: "..." }; orderErrorMessage passes 4xx text through.
  assert.strictEqual(C.orderErrorMessage({ ok: false, status: 400, error: "Please enter a 5-digit ZIP code for pickup." }), "Please enter a 5-digit ZIP code for pickup.");
});

test("every page loads the coastal design system", () => {
  for (const p of ["index.html", "order/index.html", "track/index.html", "driver/index.html", "admin/index.html", "apply/index.html"]) {
    assert.ok(read("frontend/" + p).includes("css/coastal.css"), p);
  }
});

// ── Checkout error states (/order/): inline, announced, no leaked 5xx text ──
const { weatherShutdownPayload } = require(path.join(ROOT, "netlify/functions/_weather.js"));

test("network failure (status 0) tells the customer to retry, nothing charged", () => {
  const m = C.orderErrorMessage({ ok: false, error: "Failed to fetch", status: 0 });
  assert.ok(/signal/i.test(m) && /Nothing was charged/.test(m), m);
});

test("weather hold 503 shows the hold reason create-order sends", () => {
  // CoyoteAPI surfaces body.message as result.error.
  const payload = weatherShutdownPayload({ WEATHER_SHUTDOWN: "1", WEATHER_SHUTDOWN_REASON: "Tropical storm hold until Tuesday." });
  const m = C.orderErrorMessage({ ok: false, error: payload.message, status: 503 });
  assert.strictEqual(m, "Tropical storm hold until Tuesday.");
  assert.ok(/paused/i.test(C.orderErrorMessage({ ok: false, status: 503 })));
});

test("400 validation messages pass through", () => {
  const m = C.orderErrorMessage({ ok: false, error: "Pickup address and city are required", status: 400 });
  assert.strictEqual(m, "Pickup address and city are required");
});

test("500 never leaks internal error text", () => {
  const m = C.orderErrorMessage({ ok: false, error: 'duplicate key value violates unique constraint "customers_phone_key"', status: 500 });
  assert.ok(!/duplicate key|constraint/.test(m), m);
  assert.ok(/\(361\) 555-1234/.test(m));
});

test("missing / generic result falls back to the support line", () => {
  assert.ok(/try again/i.test(C.orderErrorMessage()));
  assert.ok(/try again/i.test(C.orderErrorMessage({ ok: false, error: "Request failed", status: 404 })));
});

test("order page has inline terms + submit error regions", () => {
  const html = read("frontend/order/index.html");
  assert.ok(/id="termsError"[^>]*hidden/.test(html), "termsError starts hidden");
  // Linked only while shown (aria-describedby reads hidden text): see a11y-forms.test.js.
  assert.ok(/linkError\(terms, msg, !!show\)/.test(read("frontend/js/order.js")), "termsError linked when shown");
  assert.ok(/id="orderSubmitError"[^>]*role="alert"/.test(html), "submit error is announced");
});

test("order.js uses the inline errors, not alert(), on checkout failure", () => {
  const src = read("frontend/js/order.js");
  const submit = src.slice(src.indexOf("async function submitOrder"), src.indexOf("const trackBtn"));
  assert.ok(submit.length > 0);
  assert.ok(!/alert\(/.test(submit), "submitOrder must not alert()");
  assert.ok(/setTermsError\(true\)/.test(submit), "unchecked terms shows a message");
  assert.ok(/showSubmitError\(orderErrorMessage\(result\)\)/.test(submit));
  assert.ok(/submitting = false/.test(submit), "failure re-enables the button");
});

// ── Track an Existing Order box: inline messages, no alert() ──
test("trackErrorMessage: missing fields, offline, server error, not found", () => {
  assert.ok(/order number and the phone number/.test(C.trackErrorMessage("missing")));
  assert.ok(/signal/.test(C.trackErrorMessage({ ok: false, status: 0, error: "Failed to fetch" })));
  assert.ok(/right now/.test(C.trackErrorMessage({ ok: false, status: 500 })));
  const nf = C.trackErrorMessage({ ok: false, status: 401, error: "Invalid order number or phone" });
  assert.ok(/couldn't find that order/.test(nf), nf);
  assert.ok(/couldn't find that order/.test(C.trackErrorMessage({ ok: true, status: 404 })));
});

test("track box uses an inline status message, not alert()", () => {
  const html = read("frontend/order/index.html");
  assert.ok(/id="trackMessage"[^>]*role="status"[^>]*hidden/.test(html));
  const src = read("frontend/js/order.js");
  const track = src.slice(src.indexOf("async function trackOrder"), src.indexOf("function displayTrackingResult"));
  assert.ok(track.length > 0);
  assert.ok(!/alert\(/.test(track), "trackOrder must not alert()");
  assert.ok(/aria-invalid/.test(track));
});

console.log(`coastal: ${passed} passed`);
