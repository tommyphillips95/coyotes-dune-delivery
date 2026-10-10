#!/usr/bin/env node
/**
 * #12 PR2: fresh schema.sql must not create SSN/bank columns or a default
 * admin row, and open USING (true) policies are denied for service-role tables.
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const schema = fs.readFileSync(path.join(ROOT, "schema.sql"), "utf8");
const launch = fs.readFileSync(path.join(ROOT, "schema/launch_2026_09_22.sql"), "utf8");

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log("  ok - " + name);
}

console.log("security-schema.test.js");

test("schema.sql does not create ssn or bank columns", () => {
  assert.ok(!/ssn\s+TEXT/i.test(schema));
  assert.ok(!/bank_name\s+TEXT/i.test(schema));
  assert.ok(!/bank_account_number\s+TEXT/i.test(schema));
  assert.ok(!/bank_routing_number\s+TEXT/i.test(schema));
  assert.ok(!/bank_account_name\s+TEXT/i.test(schema));
});

test("schema.sql has vehicle_class and online for fresh installs", () => {
  assert.ok(/vehicle_class\s+TEXT/i.test(schema));
  assert.ok(/online\s+BOOLEAN/i.test(schema));
  assert.ok(/required_vehicle_class\s+TEXT/i.test(schema));
  assert.ok(/weather_hold\s+BOOLEAN/i.test(schema));
});

test("schema.sql does not insert a default admin", () => {
  assert.ok(!/INSERT\s+INTO\s+admin_users/i.test(schema));
  assert.ok(!/coyote2024/i.test(schema));
  assert.ok(!/\$2a\$10\$92IXUNpkjO0rOQ5byMi\.Ye4oKoEa3Ro9llC\/\.og\/at2\.uheWG\/igi/.test(schema));
});

test("service-role-only tables deny anon with USING/WITH CHECK false", () => {
  for (const name of [
    "Service role only for applications select",
    "Service role only for customers insert",
    "Service role only for customers select",
    "Service role only for orders insert",
    "Service role only for orders select",
    "Service role only for order_items",
    "Service role only for order_status_logs select",
    "Service role only for sms_logs select",
    "Service role only for analytics select",
    "Service role only for analytics insert",
    "Service role only for push_notification_logs select",
    "Service role only for driver_locations select",
    "Service role only for driver_locations insert",
  ]) {
    assert.ok(schema.includes(name), "missing policy " + name);
  }
  // No leftover public-open USING (true) on those tables in the RLS block
  const rls = schema.slice(schema.indexOf("Row Level Security"));
  assert.ok(!/USING\s*\(\s*true\s*\)/i.test(rls), "RLS block still has USING (true)");
  assert.ok(!/WITH CHECK\s*\(\s*true\s*\)/i.test(rls), "RLS block still has WITH CHECK (true)");
});

test("launch migration still drops legacy PII columns on existing DBs", () => {
  assert.ok(/DROP COLUMN IF EXISTS ssn/i.test(launch));
  assert.ok(/DROP COLUMN IF EXISTS bank_account_number/i.test(launch));
  assert.ok(/DELETE FROM admin_users WHERE username = 'admin'/i.test(launch));
});

console.log(passed + " checks passed");
