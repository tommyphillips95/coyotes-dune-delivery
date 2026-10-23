#!/usr/bin/env node
// Customer order flow at 375x667 (iPhone SE size) in a real browser, against
// the local mock server (tests/e2e/server.js): Supabase, Stripe, SMS and
// Firebase are mocked, nothing external is contacted.
// Opt-in: `npm run e2e` (not part of tests/run-all.js). Needs Playwright:
//   npm i --no-save playwright && npx playwright install chromium
// Optional: CHROME_PATH=/path/to/chrome, E2E_SHOTS=dir to save screenshots.
"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");
let chromium;
try { ({ chromium } = require("playwright")); } catch (_) {
  console.error("e2e: Playwright is not installed. Run: npm i --no-save playwright && npx playwright install chromium");
  process.exit(1);
}
const PORT = Number(process.env.E2E_PORT) || 8931;
process.env.PORT = String(PORT);
const B = "http://localhost:" + PORT;
const STUB = fs.readFileSync(path.join(__dirname, "stripe-stub.js"), "utf8");
const LEAFLET = "window.L={map:()=>({setView(){return this},invalidateSize(){},fitBounds(){},removeLayer(){},on(){}}),tileLayer:()=>({addTo(){}}),marker:()=>({addTo(){return this},bindPopup(){return this},setLatLng(){}}),circleMarker:()=>({addTo(){return this},bindPopup(){return this},setLatLng(){}}),latLngBounds:()=>({pad(){return{}}}),Browser:{mobile:true}}";
const SHOTS = process.env.E2E_SHOTS || "";

let browser;
async function page(width) {
  const ctx = await browser.newContext({ viewport: { width: width || 375, height: 667 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  await ctx.route("**/*", (r) => {
    const u = r.request().url();
    if (u.startsWith(B)) return r.continue();
    if (/js\.stripe\.com/.test(u)) return r.fulfill({ contentType: "application/javascript", body: STUB });
    if (/leaflet.*\.js$/.test(u)) return r.fulfill({ contentType: "application/javascript", body: LEAFLET });
    return r.fulfill({ status: 204, body: "" });
  });
  const p = await ctx.newPage();
  p.errors = [];
  p.on("pageerror", (e) => p.errors.push(e.message));
  return p;
}
const text = (p, sel) => p.evaluate((s) => { const e = document.querySelector(s); return e && e.offsetParent ? e.textContent.trim().replace(/\s+/g, " ") : null; }, sel);
const noOverflow = async (p) => assert.strictEqual(await p.evaluate(() => document.documentElement.scrollWidth), 375, "no horizontal scroll at 375px");
const shot = (p, name) => SHOTS ? p.screenshot({ path: path.join(SHOTS, name + ".png") }) : null;
const tomorrow = () => new Date(Date.now() + 86400000).toISOString().slice(0, 10);
async function fillOrder(p) {
  await p.goto(B + "/order/");
  await p.fill("#serviceDate", tomorrow()); await p.fill("#serviceTime", "10:00");
  await p.click('.form-step[data-step="1"] .next-step');
  await p.fill("#pickupAddress", "123 Beach Blvd"); await p.selectOption("#pickupCity", "Port Aransas"); await p.fill("#pickupZip", "78373");
  await p.fill("#dropoffAddress", "456 Ocean Dr"); await p.selectOption("#dropoffCity", "Port Aransas"); await p.fill("#dropoffZip", "78373");
  await p.click('.form-step[data-step="2"] .next-step'); await p.click('.form-step[data-step="3"] .next-step');
  await p.fill("#customerFirstName", "Ana"); await p.fill("#customerLastName", "Cruz"); await p.fill("#customerEmail", "ana@example.com"); await p.fill("#customerPhone", "(361) 555-0100");
  await p.click('.form-step[data-step="4"] .next-step');
  await p.check("#termsAgree", { force: true });
}
const seed = (j) => fetch(B + "/__seed", { method: "POST", body: JSON.stringify(j) });
const now = new Date().toISOString();
const ORDER = (n, status, payment_status, extra) => Object.assign({ id: "e2e-" + n, order_number: "CDD-E2E" + n, customer_id: "c-e2e", status, payment_status, service_type: "ride", pickup_address: "1 A St", dropoff_address: "9 B Rd", pickup_lat: 27.83, pickup_lng: -97.06, dropoff_lat: 27.82, dropoff_lng: -97.07, estimated_price: 27, scheduled_at: now, created_at: now }, extra || {});
async function track(p, num, phone) {
  await p.goto(B + "/track/");
  await p.fill("#lookupOrderNum", num); await p.fill("#lookupPhone", phone);
  await p.click("#lookupBtn");
  await p.waitForFunction(() => document.getElementById("lookupBtn").textContent.trim() === "Track Order");
  await p.waitForTimeout(300);
}

const tests = [];
const test = (n, f) => tests.push([n, f]);

test("card checkout: order -> pay -> confirmation -> track shows Paid", async () => {
  const p = await page();
  await fillOrder(p); await noOverflow(p);
  await p.click("#submitBtn");
  await p.waitForSelector("#paymentSubmitBtn", { timeout: 15000 }); await noOverflow(p);
  await p.click("#paymentSubmitBtn");
  await p.waitForSelector("#orderSuccess", { state: "visible", timeout: 15000 });
  const num = (await text(p, "#orderIdDisplay")) || "";
  assert.ok(/^CDD-/.test(num), "order number shown: " + num);
  await noOverflow(p); await shot(p, "e2e-card-success");
  await p.goto(B + "/track/?order=" + encodeURIComponent(num));
  await p.waitForFunction(() => /Paid/.test((document.getElementById("detailPayment") || {}).textContent || ""), null, { timeout: 15000 });
  await noOverflow(p); await shot(p, "e2e-track-paid");
  assert.deepStrictEqual(p.errors, []);
});

test("card declined: inline error, Pay Now usable again", async () => {
  const p = await page();
  await fillOrder(p); await p.click("#submitBtn");
  await p.waitForSelector("#paymentSubmitBtn", { timeout: 15000 });
  await p.evaluate(() => { window.__declineNext = true; });
  await p.click("#paymentSubmitBtn");
  await p.waitForFunction(() => /declined/.test(document.getElementById("paymentError").textContent));
  assert.strictEqual(await p.isEnabled("#paymentSubmitBtn"), true);
  await noOverflow(p); await shot(p, "e2e-card-declined");
});

test("validation: past date, bad ZIP, terms unchecked", async () => {
  const p = await page();
  await p.goto(B + "/order/");
  await p.fill("#serviceDate", "2020-01-01"); await p.fill("#serviceTime", "10:00");
  await p.click('.form-step[data-step="1"] .next-step');
  assert.ok(/future date/.test(await text(p, "#dateTimeError")));
  await p.fill("#serviceDate", tomorrow()); await p.click('.form-step[data-step="1"] .next-step');
  await p.fill("#pickupAddress", "1 A"); await p.selectOption("#pickupCity", "Port Aransas"); await p.fill("#pickupZip", "12");
  await p.click('.form-step[data-step="2"] .next-step');
  assert.ok(/5-digit ZIP/.test(await text(p, "#pickupZipError")));
  await fillOrder(p);
  await p.uncheck("#termsAgree", { force: true }); await p.click("#submitBtn");
  assert.ok(/agree/.test(await text(p, "#termsError")));
  await noOverflow(p); await shot(p, "e2e-validation-terms");
});

for (const [name, route, re] of [
  ["503", (r) => r.fulfill({ status: 503, contentType: "application/json", body: '{"error":"db"}' }), /Something went wrong placing your order/],
  ["offline", (r) => r.abort("internetdisconnected"), /tap Retry/],
]) {
  test(`create-order ${name}: error shown, Place Order usable, nothing stuck`, async () => {
    const p = await page();
    await fillOrder(p);
    await p.route("**/api/create-order", route);
    await p.click("#submitBtn");
    await p.waitForFunction(() => !!document.getElementById("orderSubmitError").textContent.trim());
    assert.ok(re.test(await text(p, "#orderSubmitError")), await text(p, "#orderSubmitError"));
    assert.strictEqual(await p.isEnabled("#submitBtn"), true);
    await noOverflow(p); await shot(p, "e2e-create-" + name);
  });
}

test("tracking: cancelled+refunded, completed, not found, wrong phone, 503", async () => {
  await seed({ customers: [{ id: "c-e2e", first_name: "Ana", last_name: "Cruz", phone: "(361) 555-0177", email: "a@example.com", created_at: now }],
    orders: [ORDER("01", "cancelled", "refunded"), ORDER("02", "completed", "paid", { stripe_payment_intent_id: "pi_x" })] });
  const p = await page();
  await track(p, "CDD-E2E01", "361-555-0177");
  assert.strictEqual(await text(p, "#detailStatus"), "Cancelled");
  assert.strictEqual(await text(p, "#driverName"), "Order cancelled");
  await noOverflow(p); await shot(p, "e2e-track-cancelled");
  await track(p, "CDD-E2E02", "3615550177");
  assert.strictEqual(await text(p, "#detailStatus"), "Completed");
  assert.strictEqual(await text(p, "#detailPayment"), "Paid");
  // Order page tracking box shows the refund.
  await p.goto(B + "/order/"); await p.fill("#trackOrderNumber", "CDD-E2E01"); await p.fill("#trackPhone", "3615550177"); await p.click("#trackBtn");
  await p.waitForFunction(() => /Refunded/.test((document.getElementById("trackingPaymentStatus") || {}).textContent || ""));
  const q = await page();
  await track(q, "CDD-NOPE99", "3615550177");
  assert.ok(/couldn't find that order/.test(await text(q, "#lookupMessage")));
  await track(q, "CDD-E2E02", "3615550000");
  assert.ok(/couldn't find that order/.test(await text(q, "#lookupMessage")), "wrong phone = not found");
  await shot(q, "e2e-track-not-found");
  await q.route("**/api/get-orders**", (r) => r.fulfill({ status: 503, contentType: "application/json", body: "{}" }));
  await track(q, "CDD-E2E01", "3615550177");
  assert.ok(/right now/.test(await text(q, "#lookupMessage")));
  await noOverflow(q);
});

test("large text: at 320px with 200% text the header fits and the menu button is on screen", async () => {
  const p = await page(320);
  for (const u of ["/order/", "/track/"]) {
    await p.goto(B + u);
    await p.addStyleTag({ content: "html{font-size:200%!important}" });
    await p.waitForTimeout(300);
    const r = await p.evaluate(() => {
      const nav = document.querySelector("nav.navbar");
      const right = Math.max(...[...nav.querySelectorAll("*")].map((e) => e.getBoundingClientRect().right));
      const t = document.querySelector("#navToggle");
      return { right, toggle: t ? t.getBoundingClientRect().right : 0, navH: nav.offsetHeight };
    });
    assert.ok(r.right <= 320, u + " header right edge " + r.right);
    assert.ok(r.toggle <= 320, u + " menu button right edge " + r.toggle);
    assert.ok(r.navH <= 110, u + " header height " + r.navH);
  }
  await p.goto(B + "/order/");
  await p.addStyleTag({ content: "html{font-size:200%!important}" });
  await shot(p, "e2e-header-320-200pct");
});

(async () => {
  const srv = await require("./server.js").start(PORT);
  browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
  if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
  let failed = 0;
  for (const [n, f] of tests) {
    try { await f(); console.log("ok - " + n); } catch (e) { failed++; console.log("not ok - " + n + "\n  " + String(e.message).split("\n")[0]); }
  }
  await browser.close(); srv.close();
  console.log(`e2e: ${tests.length - failed}/${tests.length} passed`);
  process.exit(failed ? 1 : 0);
})();
