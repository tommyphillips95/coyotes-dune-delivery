#!/usr/bin/env node
/**
 * Bulk status change: rows already at the target status are skipped (not
 * rewritten, no note). Each changed application gets a note line in the
 * existing notes field: who, when (CT), from → to. No schema change.
 */
const assert = require("assert");
const path = require("path");
const Module = require("module");
const jwt = require("jsonwebtoken");
const { createFakeSupabase } = require("./helpers/fake-supabase");

process.env.JWT_SECRET = "admin-bulk-notes-secret-32chars!!!";
process.env.SUPABASE_URL = "http://example.invalid";
process.env.SUPABASE_SERVICE_KEY = "test";
let fake = null;
const realLoad = Module._load;
Module._load = function (request) {
  if (request === "@supabase/supabase-js") return { createClient: () => fake };
  return realLoad.apply(this, arguments);
};
const admin = require(path.join(__dirname, "..", "netlify/functions/admin.js")).handler;
const T = jwt.sign({ role: "admin", user: "ops-tommy" }, process.env.JWT_SECRET);
const bulk = (ids, status) => admin({ httpMethod: "POST", path: "/.netlify/functions/admin/applications/bulk", headers: { authorization: "Bearer " + T }, body: JSON.stringify({ ids, status }) });
const OLD = "2026-01-01T00:00:00.000Z";
function seed() {
  fake = createFakeSupabase({
    applications: [
      { id: "a1", status: "pending", notes: null, updated_at: OLD, online: false },
      { id: "a2", status: "approved", notes: "checked plate", updated_at: OLD, online: true },
      { id: "a3", status: "background_check", notes: "earlier note", updated_at: OLD, online: false },
    ],
    dispatch_offers: [{ id: "of", driver_id: "a2", status: "offered" }],
    orders: [],
  });
}
const app = (id) => fake.db.applications.find((a) => a.id === id);
const tests = [];
const test = (n, f) => tests.push([n, f]);

test("unchanged rows are skipped: not rewritten, no note, counted", async () => {
  seed();
  const r = await bulk(["a1", "a2", "a3"], "approved");
  assert.strictEqual(r.statusCode, 200, r.body);
  const b = JSON.parse(r.body);
  assert.strictEqual(b.updated, 2);
  assert.strictEqual(b.skipped, 1);
  assert.deepStrictEqual(b.updated_ids.sort(), ["a1", "a3"]);
  assert.strictEqual(app("a2").notes, "checked plate");
  assert.strictEqual(app("a2").updated_at, OLD);
});

test("each changed row gets a note: who, when (CT), from → to; earlier notes kept", async () => {
  seed();
  await bulk(["a1", "a3"], "approved");
  assert.match(app("a1").notes, /^\[[A-Z][a-z]{2} \d{1,2}, \d{4}, \d{1,2}:\d{2} [AP]M CT\] Status pending → approved by admin ops-tommy \(bulk\)\.$/);
  const lines = app("a3").notes.split("\n");
  assert.strictEqual(lines[0], "earlier note");
  assert.match(lines[1], /Status background_check → approved by admin ops-tommy \(bulk\)\./);
  assert.strictEqual(app("a1").status, "approved");
});

test("de-approve in bulk: only the driver that actually changed is offboarded", async () => {
  seed();
  const r = await bulk(["a1", "a2"], "rejected");
  const b = JSON.parse(r.body);
  assert.deepStrictEqual(b.updated_ids.sort(), ["a1", "a2"]);
  assert.strictEqual(app("a2").online, false);
  assert.match(app("a2").notes, /checked plate\n.*Status approved → rejected/);
});

test("all already at target: nothing written, updated 0", async () => {
  seed();
  const before = JSON.stringify(fake.db.applications);
  const b = JSON.parse((await bulk(["a2"], "approved")).body);
  assert.strictEqual(b.updated, 0);
  assert.strictEqual(b.skipped, 1);
  assert.strictEqual(JSON.stringify(fake.db.applications), before);
});

test("unknown ids are reported, not counted as updated", async () => {
  seed();
  const b = JSON.parse((await bulk(["a1", "ghost"], "on_hold")).body);
  assert.strictEqual(b.updated, 1);
  assert.strictEqual(b.not_found, 1);
});

(async () => {
  let failed = 0;
  console.log("admin-bulk-status-notes.test.js");
  for (const [n, f] of tests) {
    try { await f(); console.log("  ok - " + n); }
    catch (e) { failed++; console.error("  FAIL - " + n + "\n    " + String(e.message || e).split("\n")[0]); }
  }
  Module._load = realLoad;
  if (failed) { console.error(`admin-bulk-status-notes: ${failed} failed`); process.exit(1); }
  console.log(`admin-bulk-status-notes: ${tests.length} passed`);
})();
