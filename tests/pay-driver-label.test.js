#!/usr/bin/env node
// Order page tracking box: pay-the-driver orders say "Pay your driver" (not
// "Pending"); card wording stays accurate; status text uses the same
// friendly labels as /track/ (no "in progress"/first-underscore-only).
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const ROOT = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
global.window = global;
global.CoyoteZones = require(path.join(ROOT, "frontend/js/zones.js")).CoyoteZones;
require(path.join(ROOT, "frontend/js/coastal.js"));
const C = global.CoyoteCoastal;
const tests = [];
const test = (n, f) => tests.push([n, f]);
const eq = (a, b) => assert.deepStrictEqual(JSON.parse(JSON.stringify(a)), b);

test("pay-the-driver order (no Stripe intent) -> 'Pay your driver'", () => {
  eq(C.paymentBadge({ payment_status: "pending", stripe_payment_intent_id: null }), { cls: "pending", label: "Pay your driver" });
  eq(C.paymentBadge({}), { cls: "pending", label: "Pay your driver" });
});
test("card orders keep accurate wording", () => {
  eq(C.paymentBadge({ payment_status: "pending", stripe_payment_intent_id: "pi_1" }), { cls: "pending", label: "Card payment pending" });
  eq(C.paymentBadge({ payment_status: "failed", stripe_payment_intent_id: "pi_1" }), { cls: "failed", label: "Card payment failed" });
  eq(C.paymentBadge({ payment_status: "paid", stripe_payment_intent_id: "pi_1" }), { cls: "paid", label: "Paid" });
  eq(C.paymentBadge({ payment_status: "refunded", stripe_payment_intent_id: "pi_1" }), { cls: "refunded", label: "Refunded" });
});
test("shared status labels: in_progress -> 'On the Way', unknown replaces every underscore", () => {
  assert.strictEqual(C.statusLabel("in_progress"), "On the Way");
  assert.strictEqual(C.statusLabel("assigned"), "Assigned");
  assert.strictEqual(C.statusLabel("driver_en_route_now"), "driver en route now");
});

function renderOrderBox(order) {
  const els = {};
  const el = (id) => (els[id] = els[id] || { id, textContent: "", className: "", classList: { add() {} }, replaceChildren(c) { this.child = c; } });
  const src = read("frontend/js/order.js");
  const start = src.indexOf("function displayTrackingResult");
  let depth = 0, i = src.indexOf("{", start);
  for (let j = i; j < src.length; j++) { if (src[j] === "{") depth++; else if (src[j] === "}" && --depth === 0) { i = j + 1; break; } }
  const ctx = vm.createContext({ window: { CoyoteCoastal: C }, document: { getElementById: el, createElement: () => ({}) }, parseFloat, String });
  vm.runInContext(src.slice(start, i) + "\ndisplayTrackingResult(order);", Object.assign(ctx, { order }));
  return els;
}
test("order page box renders the shared status label and pay-driver badge", () => {
  const els = renderOrderBox({ order_number: "CDD-1", status: "in_progress", service_type: "ride", is_asap: true, pickup_address: "a", pickup_city: "b", payment_status: "pending" });
  assert.strictEqual(els.trackingStatus.textContent, "On the Way");
  assert.strictEqual(els.trackingPaymentStatus.child.textContent, "Pay your driver");
});
test("/track/ uses the shared labels", () => {
  assert(/CoyoteCoastal[\s\S]{0,80}statusLabel/.test(read("frontend/track/track.js")));
});

let failed = 0;
for (const [n, f] of tests) { try { f(); console.log("  ok  " + n); } catch (e) { failed++; console.log("  FAIL " + n + "\n    " + e.message); } }
console.log(`${tests.length - failed}/${tests.length} pay-driver-label tests passed`);
if (failed) process.exit(1);
