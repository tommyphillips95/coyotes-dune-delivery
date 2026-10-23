#!/usr/bin/env node
/**
 * /order/?restaurant=<slug that isn't a partner>.
 * Before: the slug was silently dropped (plain order form, no explanation) and
 * the <head> script reserved prefill note + quote space for any slug-looking
 * value, then collapsed it (layout shift 0.127 on bogus slugs).
 * Now: a fixed "We couldn't find that partner" note (role=status, link to the
 * partner list, form untouched), space decided before first paint from the
 * same PARTNERS slugs, slug never echoed. Matching: case-insensitive, no
 * trimming (as partnerBySlug already did); blank restaurant= = absent.
 */
"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
const ORDER = read("frontend/order/index.html");
const ORDER_JS = read("frontend/js/order.js");
const CSS = read("frontend/css/coastal.css");
const C = require(path.join(ROOT, "frontend/js/coastal.js"));

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

const NOTE = "We couldn't find that partner. Choose a partner or start a regular order below.";
const BOGUS = "?restaurant=not-a-real-place";
const XSS = "?restaurant=%3Cimg%20src%3Dx%20onerror%3Dalert(1)%3E";

function headScript() {
  const head = ORDER.slice(0, ORDER.indexOf("</head>"));
  const m = head.match(/<script>(\(function \(s, c\)[\s\S]*?)<\/script>/);
  assert.ok(m, "space-reserving script in <head>");
  return m[1];
}
function classesFor(search) {
  const set = new Set();
  vm.runInNewContext(headScript(), { location: { search }, document: { documentElement: { classList: { add: (...a) => a.forEach((x) => set.add(x)) } } } });
  return [...set].sort().join(" ");
}

// initFromUrl from order.js against a small fake page.
function runInit(search) {
  const els = {};
  const mk = (id, extra = {}) => (els[id] = Object.assign({ id, value: "", hidden: true, textContent: "", children: [], attrs: {},
    appendChild(n) { this.children.push(n); this.textContent += n.textContent; return n; },
    getAttribute(k) { return this.attrs[k] == null ? null : this.attrs[k]; },
    scrollIntoView() {} }, extra));
  ["trackOrderNumber", "trackingSection", "pickupCity", "dropoffCity", "pickupAddress", "itemDescription", "ccPrefillNote"].forEach((id) => mk(id));
  const tag = ORDER.match(/<div[^>]*id="ccPartnerNote"[^>]*>/);
  if (tag) mk("ccPartnerNote", { attrs: { role: (/role="([^"]+)"/.exec(tag[0]) || [])[1], "aria-live": (/aria-live="([^"]+)"/.exec(tag[0]) || [])[1] } });
  const src = ORDER_JS.slice(ORDER_JS.indexOf("function initFromUrl"), ORDER_JS.indexOf("// The <head> script reserved space"));
  const ctx = {
    window: { CoyoteCoastal: C, location: { search } }, setTimeout() {},
    document: {
      getElementById: (id) => els[id] || null, querySelector: () => null,
      createElement: (t) => ({ tagName: t.toUpperCase(), href: "", textContent: "" }),
      createTextNode: (t) => ({ textContent: t }),
    },
  };
  vm.runInNewContext(src + "\ninitFromUrl();", ctx);
  return els;
}

test("head script slug list is exactly the PARTNERS slugs in coastal.js", () => {
  const m = /var P = (\[[^\]]*\])/.exec(headScript());
  assert.ok(m, "slug list in head script");
  assert.deepStrictEqual(JSON.parse(m[1].replace(/'/g, '"')), C.PARTNERS.map((p) => p.slug));
});

test("pre-paint: bogus and weird slugs reserve the not-found note only; valid/empty unchanged", () => {
  assert.strictEqual(classesFor(BOGUS), "cc-pre-partner");
  assert.strictEqual(classesFor(XSS), "cc-pre-partner");
  assert.strictEqual(classesFor("?restaurant=%E0%A4%A"), "cc-pre-partner", "undecodable");
  assert.strictEqual(classesFor(BOGUS + "&pickup=Port%20Aransas"), "cc-pre-note-1 cc-pre-partner cc-pre-quote");
  assert.strictEqual(classesFor("?restaurant=shells-seafood"), "cc-pre-note-2 cc-pre-quote");
  assert.strictEqual(classesFor("?restaurant=Shells-Seafood"), "cc-pre-note-2 cc-pre-quote", "case-insensitive");
  assert.strictEqual(classesFor("?restaurant=%20Shells-Seafood%20"), "cc-pre-partner", "not trimmed, like partnerBySlug");
  assert.strictEqual(classesFor("?restaurant=%20%20"), "", "blank = absent");
  assert.strictEqual(classesFor("?restaurant="), "");
  assert.strictEqual(classesFor("?restaurant=&category=food"), "cc-pre-note-1");
});

test("CSS: reserved note space before paint and a fixed note height (no shift on reveal)", () => {
  assert.ok(/\.cc-pre-partner #ccPartnerNote\[hidden\] \{ display: block; visibility: hidden; \}/.test(CSS));
  assert.ok(/\.cc-prefill-note\.cc-partner-note \{ min-height: 68px; color: var\(--cc-ink\); \}/.test(CSS));
  assert.ok(/'cc-pre-partner'/.test(ORDER_JS.slice(ORDER_JS.indexOf("function releaseReservedSpace"))), "class released after fill");
});

test("parseOrderParams flags unknown slugs; valid, empty and normalized slugs unchanged", () => {
  assert.strictEqual(C.parseOrderParams(BOGUS).restaurantUnknown, true);
  assert.strictEqual(C.parseOrderParams(BOGUS).restaurant, null);
  assert.strictEqual(C.parseOrderParams(XSS).restaurantUnknown, true);
  assert.strictEqual(C.parseOrderParams("?restaurant=").restaurantUnknown, false);
  assert.strictEqual(C.parseOrderParams("?restaurant=%20%20").restaurantUnknown, false);
  const v = C.parseOrderParams("?restaurant=shells-seafood");
  assert.deepStrictEqual([v.restaurant, v.restaurantUnknown, v.pickup, v.category], ["shells-seafood", false, "Padre Island", "food"]);
  assert.strictEqual(C.parseOrderParams("?restaurant=Shells-Seafood").restaurant, "shells-seafood");
  assert.strictEqual(C.parseOrderParams("?restaurant=%20Shells-Seafood%20").restaurantUnknown, true);
});

test("bogus slug: note shown with fixed text, role=status + aria-live, link to partners, form not prefilled", () => {
  const els = runInit(BOGUS);
  const n = els.ccPartnerNote;
  assert.ok(n, "#ccPartnerNote exists");
  assert.strictEqual(n.hidden, false);
  assert.strictEqual(n.textContent, NOTE);
  assert.strictEqual(n.attrs.role, "status");
  assert.strictEqual(n.attrs["aria-live"], "polite");
  const a = n.children.find((c) => c.tagName === "A");
  assert.deepStrictEqual([a.href, a.textContent], ["/#partners-menu", "Choose a partner"]);
  assert.ok(/id="partners-menu"/.test(read("frontend/index.html")), "link target exists");
  assert.strictEqual(els.pickupAddress.value, "");
  assert.strictEqual(els.ccPrefillNote.hidden, true);
});

test("XSS slug: same fixed note, slug never written to the page, no innerHTML", () => {
  const els = runInit(XSS);
  assert.strictEqual(els.ccPartnerNote.textContent, NOTE);
  for (const e of Object.values(els)) assert.ok(!/img|onerror/.test(e.textContent + e.value), e.id);
  const f = ORDER_JS.slice(ORDER_JS.indexOf("function initFromUrl"), ORDER_JS.indexOf("function releaseReservedSpace"));
  assert.ok(!/innerHTML/.test(f));
});

test("valid slug unchanged: prefill as before, no not-found note", () => {
  const els = runInit("?restaurant=shells-seafood");
  assert.strictEqual(els.ccPartnerNote.hidden, true);
  assert.strictEqual(els.pickupAddress.value, "Shells Seafood");
  assert.strictEqual(els.ccPrefillNote.textContent, "Starting your order: Shells Seafood · near Padre Island");
});

test("empty restaurant=: plain order, no note", () => {
  const els = runInit("?restaurant=");
  assert.strictEqual(els.ccPartnerNote.hidden, true);
  assert.strictEqual(els.ccPrefillNote.hidden, true);
});

let failed = 0;
console.log("partner-not-found.test.js");
for (const [name, fn] of tests) {
  try { fn(); console.log("ok - " + name); }
  catch (e) { failed++; console.log("not ok - " + name); console.log("  " + (e && e.stack || e)); }
}
if (failed) { console.error(`partner-not-found: ${failed} failed`); process.exit(1); }
console.log(`partner-not-found: ${tests.length} passed`);
