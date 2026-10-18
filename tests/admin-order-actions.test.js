#!/usr/bin/env node
// Dispatcher actions: assign a driver and move order status from the admin
// dashboard (PUT /api/admin/orders/:id) and the older PATCH /api/update-order.
// Same rules for both: admin JWT, transition map, driver eligibility, audit
// log, payment state untouched. Fake Supabase, real JWTs, Twilio env unset so
// nothing is texted.
const assert = require("assert");
const path = require("path");
const Module = require("module");
const jwt = require("jsonwebtoken");
const { createFakeSupabase } = require("./helpers/fake-supabase");
const seed = require("./fixtures/admin-orders-seed");

let fake = null;
const realLoad = Module._load;
let twilioLoaded = false;
Module._load = function (request) {
  if (request === "@supabase/supabase-js") return { createClient: () => fake };
  if (request === "twilio") { twilioLoaded = true; throw new Error("twilio must not load in tests"); }
  return realLoad.apply(this, arguments);
};
const SECRET = "test-admin-actions-secret-32bytes!";
process.env.JWT_SECRET = SECRET;
process.env.SUPABASE_URL = "http://example.invalid";
process.env.SUPABASE_SERVICE_KEY = "test";
delete process.env.TWILIO_ACCOUNT_SID; delete process.env.TWILIO_AUTH_TOKEN; delete process.env.TWILIO_PHONE_NUMBER;
delete process.env.WEATHER_SHUTDOWN; delete process.env.COYOTE_WEATHER_HOLD;
const ROOT = path.join(__dirname, "..");
const admin = require(path.join(ROOT, "netlify/functions/admin.js"));
const updateOrder = require(path.join(ROOT, "netlify/functions/update-order.js"));
const adminToken = jwt.sign({ role: "admin", user: "ops" }, SECRET);
const driverToken = jwt.sign({ role: "driver", driver_id: "d-4x4" }, SECRET);
const customerToken = jwt.sign({ role: "customer", order_id: "o-nodriver", order_number: "CDD-NODRV1" }, SECRET);
const H = (token) => Object.assign({ origin: "https://coyote-dune-delivery.netlify.app" }, token ? { authorization: "Bearer " + token } : {});

const put = (id, body, token = adminToken) => admin.handler({ httpMethod: "PUT", path: "/.netlify/functions/admin/orders/" + id, headers: H(token), body: JSON.stringify(body) });
const get = (p, token = adminToken) => admin.handler({ httpMethod: "GET", path: "/.netlify/functions/admin/" + p, headers: H(token), body: null });
const patch = (body, token = adminToken) => updateOrder.handler({ httpMethod: "PATCH", path: "/.netlify/functions/update-order", headers: H(token), body: JSON.stringify(body) });
const B = (r) => JSON.parse(r.body);
const order = (id) => fake.db.orders.find((o) => o.id === id);
const logsFor = (id) => fake.db.order_status_logs.filter((l) => l.order_id === id);
const fresh = (mut) => { fake = createFakeSupabase(seed()); if (mut) mut(fake.db); };

const tests = [];
const test = (n, f) => tests.push([n, f]);

test("auth: no token 401, driver/customer token 403, on both endpoints; nothing written", async () => {
  fresh();
  const before = JSON.stringify(fake.db.orders);
  assert.strictEqual((await put("o-nodriver", { driver_id: "d-4x4" }, null)).statusCode, 401);
  assert.strictEqual((await put("o-nodriver", { driver_id: "d-4x4" }, driverToken)).statusCode, 403);
  assert.strictEqual((await put("o-nodriver", { driver_id: "d-4x4" }, customerToken)).statusCode, 403);
  assert.strictEqual((await put("o-nodriver", { driver_id: "d-4x4" }, jwt.sign({ role: "admin" }, "wrong-secret"))).statusCode, 401);
  assert.strictEqual((await patch({ id: "o-nodriver", status: "cancelled", confirm: true }, null)).statusCode, 401);
  assert.strictEqual((await patch({ id: "o-nodriver", status: "cancelled", confirm: true }, driverToken)).statusCode, 403);
  assert.strictEqual(JSON.stringify(fake.db.orders), before);
  assert.strictEqual((await get("drivers", null)).statusCode, 401);
});

test("assign: eligible 4x4 driver -> assigned, driver set, log with who/from/to, offer expired, no live SMS", async () => {
  fresh((db) => { db.dispatch_offers = [{ id: "off-1", order_id: "o-nodriver", driver_id: "d-utv", status: "offered", expires_at: "2099-01-01T00:00:00Z" }]; });
  const r = await put("o-nodriver", { driver_id: "d-4x4", note: "called Dana" });
  assert.strictEqual(r.statusCode, 200, r.body);
  const b = B(r);
  assert.deepStrictEqual([b.from, b.to, b.order.driver_name], ["pending", "assigned", "Dana B."]);
  assert.deepStrictEqual(b.order.allowed, ["in_progress", "pending", "cancelled"]);
  assert(!/\+1555/.test(r.body), "driver phone is not sent to the browser");
  const o = order("o-nodriver");
  assert.deepStrictEqual([o.status, o.driver_id, !!o.assigned_at], ["assigned", "d-4x4", true]);
  const last = logsFor("o-nodriver").pop();
  assert.strictEqual(last.status, "assigned");
  assert.strictEqual(last.changed_by, "admin:ops");
  assert(/Admin ops: status pending → assigned; driver Dana B\. \(4x4\)\. Note: called Dana/.test(last.note), last.note);
  assert(last.created_at);
  assert.strictEqual(fake.db.dispatch_offers[0].status, "expired");
  assert.strictEqual(b.driverSms.sent, false);
  assert.strictEqual(b.driverSms.reason, "twilio_not_configured");
  assert.strictEqual(fake.db.sms_logs.length, 1);
  assert.strictEqual(twilioLoaded, false);
});

test("#66 'no driver' flag clears once a driver is assigned; GET /orders lists drivers with eligibility", async () => {
  fresh();
  const before = B(await get("orders")).orders.find((o) => o.id === "o-nodriver");
  assert(before.attention.some((a) => a.code === "no_driver"));
  const opts = Object.fromEntries(before.driver_options.map((d) => [d.id, d]));
  assert.deepStrictEqual(Object.keys(opts).sort(), ["d-2wd", "d-4x4", "d-utv"], "only approved drivers");
  assert.strictEqual(opts["d-2wd"].eligible, false);
  assert.strictEqual(opts["d-utv"].eligible, true);
  assert.strictEqual(opts["d-utv"].online, false);
  assert.deepStrictEqual(before.allowed, ["assigned", "cancelled"]);
  assert.strictEqual((await put("o-nodriver", { driver_id: "d-4x4" })).statusCode, 200);
  const after = B(await get("orders")).orders.find((o) => o.id === "o-nodriver");
  assert(!after.attention.some((a) => a.code === "no_driver"), JSON.stringify(after.attention));
  assert.strictEqual(after.driver_name, "Dana B.");
  assert(/pending → assigned/.test(after.history[0].note));
  assert.strictEqual(after.history[0].by, "admin:ops");
  const d = B(await get("drivers"));
  assert.deepStrictEqual(d.drivers.map((x) => x.id).sort(), ["d-2wd", "d-4x4", "d-utv"]);
  assert(!/phone|\+1555|email/.test(JSON.stringify(d)));
});

test("ineligible driver: 2wd on a 4x4 order 422; unapproved 422; unknown 404; nothing changes", async () => {
  fresh();
  const before = JSON.stringify(order("o-nodriver"));
  const logs = logsFor("o-nodriver").length;
  let r = await put("o-nodriver", { driver_id: "d-2wd" });
  assert.strictEqual(r.statusCode, 422); assert.strictEqual(B(r).code, "driver_ineligible");
  assert(/needs a 4x4; Ray T\. drives 2wd/.test(B(r).error), B(r).error);
  r = await put("o-nodriver", { driver_id: "a-2" });
  assert.strictEqual(r.statusCode, 422); assert.strictEqual(B(r).code, "driver_not_approved");
  r = await put("o-nodriver", { driver_id: "nope" });
  assert.strictEqual(r.statusCode, 404); assert.strictEqual(B(r).code, "driver_not_found");
  r = await patch({ id: "o-nodriver", driver_id: "d-2wd" });
  assert.strictEqual(r.statusCode, 422, "legacy endpoint enforces it too");
  assert.strictEqual(JSON.stringify(order("o-nodriver")), before);
  assert.strictEqual(logsFor("o-nodriver").length, logs);
});

test("2wd driver is fine on a mainland order; offline utv on beach order is allowed with warnings", async () => {
  fresh();
  let r = await put("o-addr", { driver_id: "d-2wd" });
  assert.strictEqual(r.statusCode, 200, r.body); assert.deepStrictEqual(B(r).warnings, []);
  r = await put("o-island", { driver_id: "d-utv" });
  assert.strictEqual(r.statusCode, 200, r.body);
  assert.deepStrictEqual(B(r).warnings, ["Lee D. is offline; call them to confirm.", "Lee D. has no beach permit on file."]);
  assert(/Warning: Lee D\. is offline/.test(logsFor("o-island").pop().note));
});

test("transitions: completed/cancelled are closed, no skipping, 'paid' is not a status", async () => {
  fresh();
  const cases = [
    ["o-ok", { status: "pending" }, 409, "invalid_transition"],          // completed -> pending
    ["o-ok", { status: "in_progress" }, 409, "invalid_transition"],
    ["o-refund", { status: "pending" }, 409, "invalid_transition"],      // cancelled -> pending
    ["o-nodriver", { status: "completed" }, 409, "invalid_transition"],  // pending -> completed
    ["o-nodriver", { status: "in_progress" }, 409, "invalid_transition"],
    ["o-nodriver", { status: "assigned" }, 422, "driver_required"],
    ["o-nodriver", { status: "pending" }, 409, "no_change"],
    ["o-nodriver", { status: "paid" }, 400, "invalid_status"],
    ["o-nodriver", { status: "refunded" }, 400, "invalid_status"],
    ["o-nodriver", {}, 400, "nothing_to_change"],
    ["o-ok", { driver_id: "d-4x4" }, 409, "invalid_transition"],          // can't reassign a completed job
    ["missing", { status: "cancelled", confirm: true }, 404, "order_not_found"],
  ];
  const before = JSON.stringify(fake.db.orders);
  for (const [id, body, code, c] of cases) {
    const r = await put(id, body);
    assert.strictEqual(r.statusCode, code, id + " " + JSON.stringify(body) + " " + r.body);
    assert.strictEqual(B(r).code, c, r.body);
  }
  assert(/Allowed: assigned, cancelled/.test(B(await put("o-nodriver", { status: "completed" })).error));
  assert(/It's closed/.test(B(await put("o-ok", { status: "pending" })).error));
  assert(/set by Stripe/.test(B(await put("o-nodriver", { status: "paid" })).error));
  const legacy = await patch({ id: "o-ok", status: "pending" });
  assert.strictEqual(legacy.statusCode, 409, "update-order used to allow completed -> pending");
  assert.strictEqual(JSON.stringify(fake.db.orders), before);
});

test("full happy path pending -> assigned -> in_progress -> completed, one log each", async () => {
  fresh();
  const n0 = logsFor("o-island").length;
  assert.strictEqual((await put("o-island", { driver_id: "d-4x4" })).statusCode, 200);
  assert.strictEqual((await put("o-island", { status: "in_progress" })).statusCode, 200);
  const r = await put("o-island", { status: "completed" });
  assert.strictEqual(r.statusCode, 200);
  const o = order("o-island");
  assert.deepStrictEqual([o.status, o.driver_id, !!o.completed_at], ["completed", "d-4x4", true]);
  const notes = logsFor("o-island").slice(n0).map((l) => l.status + ":" + /status (.*?)[;.]/.exec(l.note)[1]);
  assert.deepStrictEqual(notes, ["assigned:pending → assigned", "in_progress:assigned → in progress", "completed:in progress → completed"]);
  assert.deepStrictEqual(B(r).order.allowed, []);
});

test("unassign (assigned -> pending) clears the driver; reassign logs the swap", async () => {
  fresh();
  await put("o-island", { driver_id: "d-4x4" });
  let r = await put("o-island", { driver_id: "d-utv" });
  assert.strictEqual(r.statusCode, 200, r.body);
  assert.strictEqual(order("o-island").driver_id, "d-utv");
  assert(/assigned → assigned; driver Lee D\. \(utv\); replaces previous driver/.test(logsFor("o-island").pop().note));
  assert.strictEqual((await put("o-island", { driver_id: "d-utv" })).statusCode, 409);
  r = await put("o-island", { status: "pending" });
  assert.strictEqual(r.statusCode, 200);
  assert.strictEqual(order("o-island").driver_id, null);
  assert(/driver unassigned/.test(logsFor("o-island").pop().note));
});

test("cancel needs confirm:true; weather hold blocks assign", async () => {
  fresh((db) => { db.orders.find((o) => o.id === "o-island").weather_hold = true; });
  let r = await put("o-nodriver", { status: "cancelled" });
  assert.strictEqual(r.statusCode, 400); assert.strictEqual(B(r).code, "confirm_required");
  assert.strictEqual(order("o-nodriver").status, "pending");
  r = await put("o-nodriver", { status: "cancelled", confirm: true });
  assert.strictEqual(r.statusCode, 200);
  assert.strictEqual(order("o-nodriver").status, "cancelled");
  r = await put("o-island", { driver_id: "d-4x4" });
  assert.strictEqual(r.statusCode, 409); assert.strictEqual(B(r).code, "weather_hold");
});

test("payment state untouched: status changes never write payment fields; payment fields refused", async () => {
  fresh();
  const pay = (id) => { const o = order(id); return [o.payment_status, o.final_price, o.estimated_price, o.stripe_payment_intent_id]; };
  const before = { a: pay("o-nodriver"), b: pay("o-stripe") };
  await put("o-nodriver", { driver_id: "d-4x4" });
  await put("o-nodriver", { status: "in_progress" });
  await put("o-nodriver", { status: "completed" });
  await put("o-stripe", { status: "cancelled", confirm: true });
  assert.deepStrictEqual(pay("o-nodriver"), before.a);
  assert.deepStrictEqual(pay("o-stripe"), before.b, "cancel does not mark refunded/failed");
  for (const body of [{ payment_status: "paid" }, { status: "completed", final_price: 0 }, { driver_id: "d-4x4", paid: true }]) {
    const r = await put("o-island", body);
    assert.strictEqual(r.statusCode, 400, r.body); assert.strictEqual(B(r).code, "payment_fields_forbidden");
  }
  const legacy = await patch({ id: "o-island", status: "assigned", driver_id: "d-4x4", final_price: 1 });
  assert.strictEqual(legacy.statusCode, 400, "update-order used to write final_price from the body");
  assert.deepStrictEqual(pay("o-island"), [null, undefined, 75, undefined]);
  for (const u of fake.calls.filter((c) => c.table === "orders" && c.op === "update")) {
    for (const k of ["payment_status", "final_price", "stripe_payment_intent_id", "estimated_price"]) assert(!(k in u.payload), k);
  }
});

test("legacy update-order: changed_by comes from the JWT, not the body", async () => {
  fresh();
  const r = await patch({ id: "o-nodriver", driver_id: "d-4x4", changed_by: "stripe_webhook" });
  assert.strictEqual(r.statusCode, 200, r.body);
  assert.strictEqual(logsFor("o-nodriver").pop().changed_by, "admin:ops");
});

test("conflict: if the order moved since it was read (driver accepted an offer), refuse with 409", async () => {
  fresh();
  const realFrom = fake.from;
  let n = 0;
  fake.from = (t) => {
    const b = realFrom(t);
    if (t === "orders" && n++ === 0) {
      const realThen = b.then;
      b.then = (res, rej) => realThen((out) => { fake.db.orders.find((o) => o.id === "o-nodriver").status = "assigned"; res(out); }, rej);
    }
    return b;
  };
  const r = await put("o-nodriver", { status: "cancelled", confirm: true });
  assert.strictEqual(r.statusCode, 409, r.body); assert.strictEqual(B(r).code, "conflict");
  assert.strictEqual(order("o-nodriver").status, "assigned");
});

test("DB failure is a generic 500 (no internals)", async () => {
  fresh();
  fake.from = () => { throw new Error("relation orders does not exist SECRET-DETAIL"); };
  const orig = console.error; console.error = () => {};
  const r = await put("o-nodriver", { driver_id: "d-4x4" });
  console.error = orig;
  assert.strictEqual(r.statusCode, 500); assert(!/SECRET-DETAIL|relation/.test(r.body));
});

(async () => {
  let failed = 0;
  for (const [n, f] of tests) {
    try { await f(); console.log("ok -", n); } catch (e) { failed++; console.error("not ok -", n, "\n ", e.stack); }
  }
  console.log(failed ? `${failed} failed` : `admin-order-actions: ${tests.length} passed`);
  process.exit(failed ? 1 : 0);
})();
