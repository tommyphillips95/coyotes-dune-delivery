#!/usr/bin/env node
// Driver portal offer card: the portal HTML already contains #offer-card, so
// driver-offer.js must still add its styles (incl. .offer-card.hidden) or the
// empty card and an already-accepted offer stay on screen with live buttons.
// Runs the real frontend/js/driver-offer.js in a vm with a small fake DOM.
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const root = path.join(__dirname, "..");
const src = fs.readFileSync(path.join(root, "frontend/js/driver-offer.js"), "utf8");
const html = fs.readFileSync(path.join(root, "frontend/driver/index.html"), "utf8");

function el(id, cls) {
  const classes = new Set((cls || "").split(/\s+/).filter(Boolean));
  const e = { id, hidden: false, textContent: "", disabled: false, listeners: {}, children: [],
    classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c), contains: (c) => classes.has(c) },
    addEventListener(t, f) { (this.listeners[t] = this.listeners[t] || []).push(f); },
    appendChild(c) { this.children.push(c); return c; }, remove() {} };
  return e;
}
function setup(fetchImpl) {
  const ids = {};
  const m = html.match(/<section class="([^"]*)" id="offer-card">/);
  assert(m, "portal HTML ships #offer-card");
  ids["offer-card"] = el("offer-card", m[1]);
  ["offer-timer", "offer-route", "offer-meta", "offer-accept", "offer-decline", "offer-status", "toast-container"].forEach((i) => { ids[i] = el(i); });
  const head = el("head");
  const intervals = [];
  const document = { readyState: "complete", head, body: el("body"), getElementById: (i) => ids[i] || head.children.find((c) => c.id === i) || null,
    querySelector: () => null, createElement: () => el(null), addEventListener() {} };
  const store = { driver_session: JSON.stringify({ applicantId: "d1", token: "tok" }) };
  const ctx = vm.createContext({ document, localStorage: { getItem: (k) => store[k] || null }, fetch: fetchImpl,
    setInterval: (f) => { intervals.push(f); return intervals.length; }, clearInterval() {}, setTimeout: () => 0,
    console: { error() {}, log() {} }, Date, JSON, Math, Number, String, Promise });
  vm.runInContext(src, ctx);
  return { ids, head };
}
const flush = () => new Promise((r) => setTimeout(r, 20));
const visible = (card, head) => {
  if (card.hidden) return false;
  const css = head.children.map((c) => c.textContent || "").join("");
  return !(card.classList.contains("hidden") && /\.offer-card\.hidden\{display:none\}/.test(css));
};
const resp = (status, body) => Promise.resolve({ ok: status < 400, status, json: async () => body });
const OFFER = { id: "of1", expires_at: new Date(Date.now() + 60000).toISOString(), required_class: "4x4", distance_mi: 2, orders: { order_number: "CDD-1", pickup_city: "Port Aransas", estimated_price: 30 } };

const tests = [];
const test = (n, f) => tests.push([n, f]);

test("no pending offer: the card shipped in the portal HTML is not visible", async () => {
  const { ids, head } = setup(() => resp(200, { success: true, offer: null }));
  await flush();
  assert.strictEqual(visible(ids["offer-card"], head), false);
});

test("offer shows the card; after Accept it is hidden again", async () => {
  const seen = [];
  let pending = true;
  const { ids, head } = setup((url, opts) => {
    seen.push(url);
    if (/respond-offer/.test(url)) { pending = false; return resp(200, { success: true, action: "accepted" }); }
    return resp(200, { success: true, offer: pending ? OFFER : null });
  });
  await flush();
  assert.strictEqual(visible(ids["offer-card"], head), true, "offer visible");
  assert(/CDD-1/.test(ids["offer-meta"].textContent));
  ids["offer-accept"].listeners.click[0]();
  await flush();
  assert(seen.some((u) => /respond-offer/.test(u)));
  assert.strictEqual(visible(ids["offer-card"], head), false, "accepted offer hidden");
});

(async () => {
  let failed = 0;
  for (const [n, f] of tests) {
    try { await f(); console.log("ok - " + n); } catch (e) { failed++; console.log("not ok - " + n + "\n  " + (e && e.stack || e)); }
  }
  if (failed) process.exit(1);
})();
