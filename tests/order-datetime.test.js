#!/usr/bin/env node
/**
 * Order form default date/time must be local (America/Chicago), not UTC.
 * Bug: order.js used toISOString() for the date, so after ~7 PM CDT the form
 * defaulted to tomorrow and the date picker's min blocked booking tonight.
 */
process.env.TZ = "America/Chicago";
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
global.window = global;
const C = require(path.join(ROOT, "frontend/js/coastal.js"));

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log("  ok - " + name);
}

console.log("order-datetime.test.js");

test("TZ override is active (sanity)", () => {
  // 2026-10-18 20:00 CDT == 2026-10-19T01:00Z
  const d = new Date("2026-10-19T01:00:00Z");
  assert.strictEqual(d.getHours(), 20);
});

test("8 PM CDT: default slot stays today, min is today", () => {
  const now = new Date("2026-10-19T01:00:00Z"); // Sun Oct 18, 8:00 PM CDT
  assert.strictEqual(now.toISOString().split("T")[0], "2026-10-19", "UTC would say tomorrow");
  const slot = C.defaultServiceSlot(now, 30);
  assert.deepStrictEqual(slot, { date: "2026-10-18", time: "20:30", minDate: "2026-10-18" });
});

test("11:45 PM CDT: +30 min rolls to tomorrow, min stays today", () => {
  const now = new Date("2026-10-19T04:45:00Z"); // 11:45 PM CDT
  const slot = C.defaultServiceSlot(now, 30);
  assert.deepStrictEqual(slot, { date: "2026-10-19", time: "00:15", minDate: "2026-10-18" });
});

test("morning CST (after DST ends) formats with zero padding", () => {
  const now = new Date("2026-11-05T14:05:00Z"); // 8:05 AM CST
  const slot = C.defaultServiceSlot(now);
  assert.deepStrictEqual(slot, { date: "2026-11-05", time: "08:35", minDate: "2026-11-05" });
});

test("default slot round-trips through order.js's Central parse and is in the future", () => {
  const now = new Date("2026-10-19T01:00:00Z");
  const slot = C.defaultServiceSlot(now, 30);
  const parsed = C.centralInstant(slot.date, slot.time); // how validateStep/submitOrder read it
  assert.strictEqual(parsed.getTime() - now.getTime(), 30 * 60000);
});

test("order.js no longer derives date inputs from UTC", () => {
  const src = fs.readFileSync(path.join(ROOT, "frontend/js/order.js"), "utf8");
  assert.ok(!/toISOString\(\)\.split/.test(src), "order.js must not use toISOString() for date inputs");
  assert.ok(/defaultServiceSlot/.test(src), "order.js uses CoyoteCoastal.defaultServiceSlot");
});

// ── Phone set to another zone: the form still works in Central time ──
// Node re-reads process.env.TZ, so these run as a Pacific / Tokyo phone.
for (const tz of ["America/Los_Angeles", "Asia/Tokyo"]) {
  test(`phone on ${tz}: default slot, offset and display are Central`, () => {
    process.env.TZ = tz;
    try {
      const now = new Date("2026-10-19T01:00:00Z"); // 8 PM CDT, 6 PM PDT, 10 AM JST next day
      assert.notStrictEqual(now.getHours(), 20, "really running in another zone");
      const slot = C.defaultServiceSlot(now, 30);
      assert.deepStrictEqual(slot, { date: "2026-10-18", time: "20:30", minDate: "2026-10-18" });
      assert.strictEqual(C.centralIso(slot.date, slot.time), "2026-10-18T20:30:00-05:00");
      assert.strictEqual(C.centralInstant(slot.date, slot.time).toISOString(), "2026-10-19T01:30:00.000Z");
      assert.ok(C.centralInstant(slot.date, slot.time) > now, "not 'already passed'");
      assert.strictEqual(C.formatCentral(C.centralInstant("2026-10-18", "20:30")), "Sun, Oct 18, 8:30 PM CDT");
    } finally {
      process.env.TZ = "America/Chicago";
    }
  });
}

test("centralIso uses the right offset on each side of DST", () => {
  assert.strictEqual(C.centralIso("2026-11-01", "00:30"), "2026-11-01T00:30:00-05:00"); // before fall-back
  assert.strictEqual(C.centralIso("2026-11-01", "03:00"), "2026-11-01T03:00:00-06:00"); // after
  assert.strictEqual(C.centralIso("2026-03-08", "01:30"), "2026-03-08T01:30:00-06:00"); // before spring-forward
  assert.strictEqual(C.centralIso("2026-03-08", "03:30"), "2026-03-08T03:30:00-05:00"); // after
  assert.strictEqual(C.centralIso("bad", "20:30"), null);
});

test("order.js schedules in Central and sends scheduled_at with an offset", () => {
  const src = fs.readFileSync(path.join(ROOT, "frontend/js/order.js"), "utf8");
  assert.ok(/scheduled_at: isAsap \? null : serviceIso\(dateVal, timeVal\)/.test(src));
  assert.ok(!/new Date\(`\$\{date\.value\}T\$\{time\.value\}`\)/.test(src), "step 1 validation must not parse device-local");
  assert.ok(/const chosen = serviceInstant\(dateVal, timeVal\)/.test(src));
  const html = fs.readFileSync(path.join(ROOT, "frontend/order/index.html"), "utf8");
  assert.ok(/Time \(Central\)<\/label>/.test(html) && /id="serviceTzHint"/.test(html));
});

console.log(`order-datetime: ${passed} passed`);
