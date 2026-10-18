#!/usr/bin/env node
// LAUNCH.md "Post-deploy smoke test": the texts it tells a person to expect
// must be the ones the code actually shows/sends, and its links must resolve.
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const ROOT = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
const md = read("LAUNCH.md");
const start = md.indexOf("## Post-deploy smoke test");
const section = start >= 0 ? md.slice(start, (md.indexOf("\n## ", start + 5) + 1 || md.length + 1) - 1) : "";
const tests = [];
const test = (n, f) => tests.push([n, f]);

test("section exists, is a checkbox list, and covers every area", () => {
  assert(section, "LAUNCH.md has '## Post-deploy smoke test'");
  const boxes = section.match(/^- \[ \] \*\*/gm) || [];
  assert(boxes.length >= 10 && boxes.length <= 14, "10-14 checkbox steps, got " + boxes.length);
  for (const t of ["/order/?track=", "/track/?order=", "Pay Later", "78418", "airplane mode", "4242", "3-D Secure", "Already Paid", "Twilio", "need attention", "4x4", "Mark in progress", "partial", "Cleanup"]) {
    assert(section.includes(t), "mentions " + t);
  }
});

test("links to existing sections resolve, and Stripe steps aren't duplicated", () => {
  const anchors = new Set((md.match(/^#{1,6} .+$/gm) || []).map((h) => h.replace(/^#+ /, "").toLowerCase().replace(/[^a-z0-9 -]/g, "").trim().replace(/ /g, "-")));
  const links = [...section.matchAll(/\]\(#([^)]+)\)/g)].map((m) => m[1]);
  assert(links.length >= 2, "references the Stripe test-mode checklist");
  links.forEach((l) => assert(anchors.has(l), "anchor #" + l + " exists"));
  assert(!section.includes("4000 0025 0000 3155") && !section.includes("curl "), "card/curl details stay in the Stripe section");
});

test("quoted UI / SMS text matches the code", () => {
  const src = {
    create: read("netlify/functions/create-order.js"), admin: read("netlify/functions/admin.js"), offer: read("netlify/functions/respond-offer.js"),
    adminUi: read("frontend/admin/admin.js"), coastal: read("frontend/js/coastal.js"), order: read("frontend/order/index.html"),
    pay: read("frontend/js/stripe-payment.js"), track: read("frontend/track/track.js"), oa: read("netlify/functions/_order-admin.js"),
  };
  const pairs = [
    ["We'll assign a driver shortly. — Coyote's Dune Delivery", src.create],
    ["Call dispatch if you can't take it.", src.admin],
    ['" accepted "', src.offer], ['". Track: " + trackUrl(order.order_number)', src.offer],
    ["You're offline. Reconnect, then tap Retry. Nothing was charged.", src.coastal],
    ["(pay your driver)", src.coastal], ["Pay Later", src.pay], ["Order Confirmed", src.pay],
    ["On Padre Island (beach)", src.order], ["Flour Bluff / mainland Corpus Christi", src.order], ["Where is your pickup?", src.order],
    ["Mark in progress", src.adminUi], ["Mark completed", src.adminUi], ["Cancel order", src.adminUi], ["need${flagged === 1 ? 's' : ''} attention", src.adminUi],
    ["Driver on the way", src.track], ["Trip completed", src.track], ["On the Way", src.track],
    ["status ${label(from)} → ${label(to)}", src.oa],
  ];
  for (const [t, s] of pairs) assert(s.includes(t), "code still has: " + t);
  assert(section.includes("You're offline. Reconnect, then tap Retry. Nothing was charged."));
  assert(section.includes("We'll assign a driver shortly. — Coyote's Dune Delivery"));
  assert(!/token=/.test(section), "tracking links carry no token");
});

let failed = 0;
for (const [n, f] of tests) { try { f(); console.log("ok -", n); } catch (e) { failed++; console.error("not ok -", n, "\n ", e.message); } }
console.log(failed ? `${failed} failed` : `launch-smoke: ${tests.length} passed`);
process.exit(failed ? 1 : 0);
