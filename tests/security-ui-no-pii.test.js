#!/usr/bin/env node
/**
 * #12 PR3: admin/driver UI must not display or edit SSN/bank fields
 * against dropped columns. Payouts go through Stripe Connect later.
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), "utf8");
}

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log("  ok - " + name);
}

console.log("security-ui-no-pii.test.js");

test("admin detail view has no SSN or bank account fields", () => {
  const src = read("frontend/admin/admin.js");
  assert.ok(!/SSN \(Last 4\)/.test(src));
  assert.ok(!/ssn_last4/.test(src));
  assert.ok(!/label>Account Number</.test(src));
  assert.ok(!/label>Routing Number</.test(src));
  assert.ok(!/app\.bank_account/.test(src));
  assert.ok(!/app\.bank_routing/.test(src));
  assert.ok(!/Insurance & Bank/.test(src));
});

test("checkr admin detail does not render SSN", () => {
  const src = read("frontend/admin/checkr.js");
  assert.ok(!/label>SSN</.test(src));
  assert.ok(!/candidate\.ssn/.test(src));
});

test("driver portal has no bank edit inputs", () => {
  const html = read("frontend/driver/index.html");
  assert.ok(!/edit-bank-name/.test(html));
  assert.ok(!/edit-bank-account/.test(html));
  assert.ok(!/edit-bank-routing/.test(html));
  assert.ok(!/name="bank_/.test(html));
});

test("driver.js does not show or prefill bank numbers", () => {
  const src = read("frontend/driver/driver.js");
  assert.ok(!/data\.bank_account/.test(src));
  assert.ok(!/data\.bank_routing/.test(src));
  assert.ok(!/edit-bank-/.test(src));
});

test("apply flow still refuses SSN/bank and explains Checkr/Stripe", () => {
  const apply = read("frontend/apply/index.html");
  assert.ok(/never store SSN or bank/i.test(apply));
  const submit = read("frontend/js/apply-submit.js");
  assert.ok(submit.includes('"ssn"'));
  assert.ok(submit.includes('"routingNumber"'));
});

console.log(passed + " passed");
