#!/usr/bin/env node
/**
 * Mobile pass on /order/ and /track/: static guards for the things a 360-390px
 * phone audit (headless Chromium) caught. No network, no browser.
 */
"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
const ORDER = read("frontend/order/index.html");
const TRACK = read("frontend/track/index.html");
const CSS = read("frontend/css/style.css");
const PAY = read("frontend/js/stripe-payment.js");

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

const inputs = (html) => (html.match(/<input\b[^>]*>/g) || []).map((tag) => {
  const a = {}; tag.replace(/([\w-]+)="([^"]*)"/g, (_, k, v) => { a[k] = v; }); return a;
});
const rule = (src, sel) => {
  const i = src.indexOf(sel + " {"); assert.ok(i >= 0, "missing rule " + sel);
  return src.slice(i, src.indexOf("}", i));
};

test("both pages opt into safe-area insets (viewport-fit=cover)", () => {
  for (const [n, h] of [["order", ORDER], ["track", TRACK]]) assert.match(h, /name="viewport"[^>]*viewport-fit=cover/, n);
});

test("fixed bars pad for the notch / home indicator", () => {
  assert.match(rule(CSS, ".navbar"), /env\(safe-area-inset-top/);
  assert.match(rule(CSS, ".chat-widget"), /env\(safe-area-inset-bottom/);
  assert.match(CSS, /\.form-page \{[^}]*padding-bottom: calc\(64px \+ env\(safe-area-inset-bottom/);
});

test("every 100vh has a dvh override right after it", () => {
  for (const src of [CSS, TRACK, ORDER]) {
    const re = /(min-)?height: (\d+)vh;/g; let m;
    while ((m = re.exec(src))) {
      const rest = src.slice(m.index + m[0].length, m.index + m[0].length + 60);
      assert.ok(rest.includes(`${m[1] || ""}height: ${m[2]}dvh`), "no dvh fallback after: " + m[0]);
    }
  }
});

test("phone, email, ZIP and name fields have autocomplete + the right keyboard", () => {
  const all = inputs(ORDER).concat(inputs(TRACK));
  const byId = Object.fromEntries(all.filter((a) => a.id).map((a) => [a.id, a]));
  for (const a of all) {
    if (a.type === "tel") { assert.strictEqual(a.autocomplete, "tel", a.id); assert.strictEqual(a.inputmode, "tel", a.id); }
    if (a.type === "email") { assert.strictEqual(a.autocomplete, "email", a.id); assert.strictEqual(a.inputmode, "email", a.id); }
    if (/Zip$/.test(a.id || "")) { assert.strictEqual(a.inputmode, "numeric", a.id); assert.ok(a.autocomplete, a.id + " needs an autocomplete value"); }
  }
  assert.strictEqual(byId.customerFirstName.autocomplete, "given-name");
  assert.strictEqual(byId.customerLastName.autocomplete, "family-name");
  for (const id of ["customerPhone", "customerEmail", "trackPhone", "lookupPhone", "pickupZip", "dropoffZip"]) assert.ok(byId[id], id);
});

test("inputs are >= 16px on phones (no iOS focus zoom)", () => {
  const mq = ORDER.slice(ORDER.indexOf("@media (max-width: 768px)"));
  assert.match(mq, /\.form-group input, \.form-group select, \.form-group textarea,\s*\.tracking-form input \{ font-size: 16px; \}/);
  assert.match(TRACK, /\.lookup-form input, \.lookup-form button \{[^}]*font-size: 1rem/);
});

test("hidden passenger/bag radios can't widen the page (step 3 overflow)", () => {
  assert.match(rule(ORDER, ".detail-card"), /position: relative/);
  const inp = rule(ORDER, ".detail-card input");
  assert.match(inp, /width: 1px/); assert.match(inp, /height: 1px/); assert.match(inp, /pointer-events: none/);
});

test("pay / submit buttons scroll clear of the keyboard and home indicator", () => {
  assert.match(ORDER, /#submitBtn, #paymentSubmitBtn[^{]*\{ scroll-margin-bottom: calc\(24px \+ env\(safe-area-inset-bottom/);
  assert.match(CSS, /html \{ scroll-padding-top: calc\(88px/);
});

test("track: map uses dvh, hint wraps, zoom buttons are 44px", () => {
  assert.match(TRACK, /#map \{[^}]*height: 45dvh/);
  assert.doesNotMatch(TRACK, /\.map-hint \{[^}]*white-space: nowrap/);
  assert.match(TRACK, /\.map-hint \{[^}]*max-width: calc\(100% - 24px\)/);
  assert.match(TRACK, /\.leaflet-touch \.leaflet-bar a \{ width: 44px; height: 44px;/);
});

test("Stripe.js is not render-blocking; initStripe loads it on demand", () => {
  assert.doesNotMatch(ORDER, /<script[^>]+src="https:\/\/js\.stripe\.com/);
  assert.match(ORDER, /<link rel="preconnect" href="https:\/\/js\.stripe\.com"/);
  assert.match(PAY, /const STRIPE_JS_URL = 'https:\/\/js\.stripe\.com\/v3\/'/);
  const init = PAY.slice(PAY.indexOf("async function initStripe()"));
  assert.ok(init.indexOf("await loadStripeJs()") > 0 && init.indexOf("await loadStripeJs()") < init.indexOf("typeof Stripe === 'undefined'"));
});

let failed = 0;
for (const [name, fn] of tests) {
  try { fn(); console.log("ok -", name); }
  catch (e) { failed++; console.error("not ok -", name, "\n ", e.message); }
}
console.log(`\nmobile-pass: ${tests.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
