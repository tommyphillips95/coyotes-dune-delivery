#!/usr/bin/env node
// Admin assign texts the customer once: first name only, /track/?order= link
// (no token), via the shared _order-admin path (dashboard + legacy
// update-order). Fake Twilio client, fake Supabase; nothing leaves the process.
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const Module = require("module");
const jwt = require("jsonwebtoken");
const { createFakeSupabase } = require("./helpers/fake-supabase");
const seed = require("./fixtures/admin-orders-seed");

let fake = null;
let sent = [];
let twilioLoads = 0;
let twilioFail = null; // Error to throw from messages.create, or a function(to) -> Error|null
const realLoad = Module._load;
Module._load = function (request) {
  if (request === "@supabase/supabase-js") return { createClient: () => fake };
  if (request === "twilio") {
    twilioLoads++;
    return () => ({ messages: { create: async (m) => {
      const err = typeof twilioFail === "function" ? twilioFail(m.to) : twilioFail;
      if (err) throw err;
      sent.push(m); return { sid: "SM_test_" + sent.length };
    } } });
  }
  return realLoad.apply(this, arguments);
};
const SECRET = "test-assign-sms-secret-32-bytes!!!";
const LIVE = "https://coyote-dune-delivery.netlify.app";
Object.assign(process.env, { JWT_SECRET: SECRET, SUPABASE_URL: "http://example.invalid", SUPABASE_SERVICE_KEY: "test", SITE_ORIGIN: LIVE });
delete process.env.WEATHER_SHUTDOWN; delete process.env.COYOTE_WEATHER_HOLD;
const TWILIO = { TWILIO_ACCOUNT_SID: "ACtest", TWILIO_AUTH_TOKEN: "test", TWILIO_PHONE_NUMBER: "+15555550100" };
const twilioOn = () => Object.assign(process.env, TWILIO);
const twilioOff = () => Object.keys(TWILIO).forEach((k) => delete process.env[k]);

const ROOT = path.join(__dirname, "..");
const FN = path.join(ROOT, "netlify/functions");
const admin = require(path.join(FN, "admin.js"));
const updateOrder = require(path.join(FN, "update-order.js"));
const respondOffer = require(path.join(FN, "respond-offer.js"));
const assignSms = require(path.join(FN, "_assign-sms.js"));
const adminToken = jwt.sign({ role: "admin", user: "ops" }, SECRET);
const H = () => ({ origin: LIVE, authorization: "Bearer " + adminToken });
const put = (id, body) => admin.handler({ httpMethod: "PUT", path: "/.netlify/functions/admin/orders/" + id, headers: H(), body: JSON.stringify(body) });
const patch = (body) => updateOrder.handler({ httpMethod: "PATCH", path: "/.netlify/functions/update-order", headers: H(), body: JSON.stringify(body) });
const B = (r) => JSON.parse(r.body);
const quiet = async (fn) => { const e = console.error, l = console.log; console.error = () => {}; console.log = () => {}; try { return await fn(); } finally { console.error = e; console.log = l; } };

const CUSTOMER = "+15555550177";
const DRIVER_PHONES = ["+15555550101", "+15555550102", "+15555550103"];
const fresh = (mut) => {
  sent = []; twilioFail = null;
  fake = createFakeSupabase(Object.assign(seed(), { customers: [{ id: "c-1", phone: CUSTOMER }], sms_logs: [] }));
  const o = fake.db.orders.find((x) => x.id === "o-nodriver");
  o.customer_id = "c-1";
  if (mut) mut(fake.db);
};
const order = () => fake.db.orders.find((x) => x.id === "o-nodriver");
const toCustomer = () => sent.filter((m) => m.to === CUSTOMER);
const customerLogs = () => fake.db.sms_logs.filter((l) => l.phone_number === CUSTOMER);
const URL = LIVE + "/track/?order=CDD-NODRV1";

const tests = [];
const test = (n, f) => tests.push([n, f]);

test("dashboard assign: customer gets one text, first name only, tracking link without token, no driver phone", async () => {
  fresh(); twilioOn();
  const r = await quiet(() => put("o-nodriver", { driver_id: "d-4x4" }));
  assert.strictEqual(r.statusCode, 200, r.body);
  assert.deepStrictEqual(B(r).customerSms, { sent: true, reason: null });
  const c = toCustomer();
  assert.strictEqual(c.length, 1);
  assert.strictEqual(c[0].body, `Your driver Dana has been assigned to order CDD-NODRV1. Track: ${URL} — Coyote's Dune Delivery`);
  assert(!/Beach|B\./.test(c[0].body), "no last name or initial");
  assert(!/token|\+1555|555-?555/.test(c[0].body), "no token, no phone numbers");
  assert.strictEqual(/https?:\/\/\S+/.exec(c[0].body)[0], URL);
  assert.strictEqual(c[0].from, TWILIO.TWILIO_PHONE_NUMBER);
  assert.deepStrictEqual(customerLogs().map((l) => [l.status, l.order_id, l.message]), [["sent", "o-nodriver", c[0].body]]);
  assert.strictEqual(sent.filter((m) => m.to === DRIVER_PHONES[0]).length, 1, "driver still gets their text");
  assert(!r.body.includes(CUSTOMER), "customer phone not sent back to the browser");
  twilioOff();
});

test("legacy PATCH update-order: same text, exactly once (no second copy from update-order itself)", async () => {
  fresh(); twilioOn();
  const r = await quiet(() => patch({ id: "o-nodriver", driver_id: "d-4x4" }));
  assert.strictEqual(r.statusCode, 200, r.body);
  assert.strictEqual(toCustomer().length, 1);
  assert(/^Your driver Dana has been assigned to order CDD-NODRV1\. Track: /.test(toCustomer()[0].body));
  assert.strictEqual(customerLogs().length, 1);
  twilioOff();
});

test("Twilio not configured: assignment saved, nothing sent, logged as twilio_not_configured", async () => {
  fresh(); twilioOff(); const loads = twilioLoads;
  const r = await quiet(() => put("o-nodriver", { driver_id: "d-4x4" }));
  assert.strictEqual(r.statusCode, 200, r.body);
  assert.deepStrictEqual(B(r).customerSms, { sent: false, reason: "twilio_not_configured" });
  assert.deepStrictEqual([order().status, order().driver_id], ["assigned", "d-4x4"]);
  assert.strictEqual(twilioLoads, loads, "twilio never loaded");
  assert.deepStrictEqual(customerLogs().map((l) => [l.status, l.error]), [["failed", "twilio_not_configured"]]);
});

test("Twilio error or customer lookup error: assignment is never rolled back", async () => {
  fresh(); twilioOn();
  twilioFail = (to) => (to === CUSTOMER ? Object.assign(new Error("Service unavailable"), { code: 20503 }) : null);
  let r = await quiet(() => put("o-nodriver", { driver_id: "d-4x4" }));
  assert.strictEqual(r.statusCode, 200, r.body);
  assert.deepStrictEqual(B(r).customerSms, { sent: false, reason: "20503: Service unavailable" });
  assert.deepStrictEqual([order().status, order().driver_id], ["assigned", "d-4x4"]);
  assert.deepStrictEqual(customerLogs().map((l) => l.status), ["failed"]);
  assert(fake.db.order_status_logs.some((l) => l.order_id === "o-nodriver" && l.status === "assigned"), "audit log kept");

  // database trouble while texting: still 200, still assigned
  fresh(); twilioOn();
  const realFrom = fake.from;
  fake.from = (t) => (t === "customers" ? { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: new Error("db down") }) }) }) } : realFrom(t));
  r = await quiet(() => put("o-nodriver", { driver_id: "d-4x4" }));
  assert.strictEqual(r.statusCode, 200, r.body);
  assert.deepStrictEqual(B(r).customerSms, { sent: false, reason: "error" });
  assert.strictEqual(order().driver_id, "d-4x4");
  twilioOff();
});

test("no duplicate: unassign + re-assign the same driver sends nothing new; a different driver gets one text", async () => {
  fresh(); twilioOn();
  await quiet(() => put("o-nodriver", { driver_id: "d-4x4" }));
  assert.strictEqual((await quiet(() => put("o-nodriver", { status: "pending" }))).statusCode, 200);
  const again = await quiet(() => put("o-nodriver", { driver_id: "d-4x4" }));
  assert.strictEqual(again.statusCode, 200, again.body);
  assert.deepStrictEqual(B(again).customerSms, { sent: false, reason: "already_sent" });
  assert.strictEqual(toCustomer().length, 1);
  const swap = await quiet(() => put("o-nodriver", { driver_id: "d-utv" }));
  assert.strictEqual(swap.statusCode, 200, swap.body);
  assert.strictEqual(toCustomer().length, 2);
  assert(/^Your driver Lee has been assigned/.test(toCustomer()[1].body));
  // a failed earlier attempt doesn't count as sent: the next assign tries again
  fresh(); twilioOff();
  await quiet(() => put("o-nodriver", { driver_id: "d-4x4" }));
  await quiet(() => put("o-nodriver", { status: "pending" }));
  twilioOn();
  await quiet(() => put("o-nodriver", { driver_id: "d-4x4" }));
  assert.strictEqual(toCustomer().length, 1);
  twilioOff();
});

test("no duplicate after the auto-offer 'accepted' text for the same driver", async () => {
  fresh((db) => { db.dispatch_offers = [{ id: "off-1", order_id: "o-nodriver", driver_id: "d-4x4", status: "offered", expires_at: "2099-01-01T00:00:00Z" }]; });
  twilioOn();
  const driverJwt = jwt.sign({ role: "driver", driver_id: "d-4x4" }, SECRET);
  const acc = await quiet(() => respondOffer.handler({ httpMethod: "POST", headers: { origin: LIVE, authorization: "Bearer " + driverJwt }, body: JSON.stringify({ offer_id: "off-1", action: "accept" }) }));
  assert.strictEqual(acc.statusCode, 200, acc.body);
  assert.strictEqual(toCustomer().length, 1, "accept text");
  assert(toCustomer()[0].body.includes(URL));
  await quiet(() => put("o-nodriver", { status: "pending" }));
  const r = await quiet(() => put("o-nodriver", { driver_id: "d-4x4" }));
  assert.strictEqual(B(r).customerSms.reason, "already_sent");
  assert.strictEqual(toCustomer().length, 1);
  twilioOff();
});

test("STOP: a number Twilio reported as unsubscribed (21610) is not texted again", async () => {
  fresh(); twilioOn();
  twilioFail = (to) => (to === CUSTOMER ? Object.assign(new Error("Attempt to send to unsubscribed recipient"), { code: 21610 }) : null);
  await quiet(() => put("o-nodriver", { driver_id: "d-4x4" }));
  assert.strictEqual(customerLogs()[0].error, "21610: Attempt to send to unsubscribed recipient", "Twilio code kept in the log");
  twilioFail = null;
  await quiet(() => put("o-nodriver", { status: "pending" }));
  const r = await quiet(() => put("o-nodriver", { driver_id: "d-utv" }));
  assert.strictEqual(r.statusCode, 200);
  assert.deepStrictEqual(B(r).customerSms, { sent: false, reason: "opted_out" });
  assert.strictEqual(toCustomer().length, 0);
  assert.strictEqual(customerLogs().length, 1, "no new attempt logged");
  twilioOff();
});

test("no first name -> 'A driver has been assigned'; no customer phone -> nothing sent; unassign/status moves don't text", async () => {
  fresh((db) => { db.applications.find((a) => a.id === "d-4x4").first_name = "  "; }); twilioOn();
  await quiet(() => put("o-nodriver", { driver_id: "d-4x4" }));
  assert.strictEqual(toCustomer()[0].body, `A driver has been assigned to order CDD-NODRV1. Track: ${URL} — Coyote's Dune Delivery`);
  sent = [];
  await quiet(() => put("o-nodriver", { status: "in_progress" }));
  assert.strictEqual(toCustomer().length, 0, "status moves don't send the assign text");

  fresh((db) => { db.customers[0].phone = null; }); twilioOn();
  const r = await quiet(() => put("o-nodriver", { driver_id: "d-4x4" }));
  assert.deepStrictEqual(B(r).customerSms, { sent: false, reason: "no_phone" });
  assert.strictEqual(toCustomer().length, 0);
  assert.strictEqual(customerLogs().length, 0);
  twilioOff();
});

test("first name is cleaned and capped; never includes the last name", () => {
  assert.strictEqual(assignSms.firstName({ first_name: "Mary Ann", last_name: "X" }), "Mary");
  assert(!/[<>]/.test(assignSms.firstName({ first_name: "<script>" })));
  assert.strictEqual(assignSms.firstName({ first_name: "José" }), "José");
  assert.strictEqual(assignSms.firstName({ first_name: "A".repeat(50) }).length, 30);
  assert.strictEqual(assignSms.firstName(null), "");
});

test("docs: LAUNCH smoke note and README quote the text the code sends", () => {
  const md = fs.readFileSync(path.join(ROOT, "LAUNCH.md"), "utf8");
  const smoke = md.slice(md.indexOf("## Post-deploy smoke test"));
  assert(smoke.includes(`"Your driver <first name> has been assigned to order CDD-…. Track: SITE/track/?order=CDD-… — Coyote's Dune Delivery"`));
  assert(/no second text/.test(smoke));
  const text = assignSms.assignedText("CDD-AB12", { first_name: "Zed" });
  assert.strictEqual(text.replace("Zed", "<first name>").replace(LIVE, "SITE").replace(/CDD-AB12/g, "CDD-…"),
    "Your driver <first name> has been assigned to order CDD-…. Track: SITE/track/?order=CDD-… — Coyote's Dune Delivery");
  const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
  assert(readme.includes("Your driver [First name] has been assigned to order CDD-…. Track: [URL] — Coyote's Dune Delivery"));
  const uo = fs.readFileSync(path.join(FN, "update-order.js"), "utf8");
  assert(!/is on the way!/.test(uo), "old full-name 'on the way' text is gone");
});

(async () => {
  let failed = 0;
  for (const [n, f] of tests) {
    try { await f(); console.log("ok -", n); } catch (e) { failed++; console.error("not ok -", n, "\n ", e.stack); }
  }
  console.log(failed ? `${failed} failed` : `assign-customer-sms: ${tests.length} passed`);
  process.exit(failed ? 1 : 0);
})();
