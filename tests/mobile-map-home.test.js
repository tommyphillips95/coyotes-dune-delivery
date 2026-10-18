#!/usr/bin/env node
// Mobile pass 2: /track/ map sizing + touch behaviour, home tap targets,
// and the "View Menu →" partner deep links (/order/?restaurant=<slug>).
// Static/unit checks; behaviour is smoke-tested in a mobile browser locally.
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const root = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");
const C = require(path.join(root, "frontend/js/coastal.js"));
let failed = 0;
function test(name, fn) { try { fn(); console.log("ok - " + name); } catch (e) { failed++; console.error("not ok - " + name + "\n  " + e.message); } }

const trackHtml = read("frontend/track/index.html");
const trackJs = read("frontend/track/track.js");
const home = read("frontend/index.html");
const coastal = read("frontend/css/coastal.css");
const style = read("frontend/css/style.css");

test("track map: phone height is viewport-based with min/max; desktop keeps 500px", () => {
  const m = trackHtml.match(/@media \(max-width: 900px\) \{\s*\.map-container \{ min-height: 0; \}\s*#map \{([^}]*)\}/);
  assert(m, "mobile #map rule");
  assert(/height: 4\dvh/.test(m[1]) && /min-height: \d+px/.test(m[1]) && /max-height: \d+px/.test(m[1]), m[1]);
  assert(/#map \{ width: 100%; height: 100%; min-height: 500px; \}/.test(trackHtml), "desktop rule unchanged");
});

test("track map: touch screens get one-finger page scroll (dragging off) and a hint", () => {
  assert(/touch \? \{ dragging: false/.test(trackJs), "dragging disabled on touch");
  assert(/id="mapHint"/.test(trackHtml), "hint element");
});

test("track map: invalidateSize on show and on resize/rotation", () => {
  assert(/map\.invalidateSize\(\);\n/.test(trackJs), "invalidate after readyMap");
  assert(/new ResizeObserver\(resizeMapSoon\)/.test(trackJs) && /"orientationchange", resizeMapSoon/.test(trackJs));
});

test("track map: zoom buttons >= 44px on coarse pointers", () => {
  const m = trackHtml.match(/@media \(pointer: coarse\) \{\s*\.leaflet-touch \.leaflet-bar a \{ width: (\d+)px; height: (\d+)px/);
  assert(m && +m[1] >= 44 && +m[2] >= 44);
});

test("home: search field, Search button, town picker, partner links >= 44px tall", () => {
  assert(/\.cc-search input \{ min-height: (4[4-9]|[5-9]\d)px; \}/.test(coastal), "search input");
  const b = coastal.match(/\.cc-search \.btn \{[^}]*min-height: (\d+)px/); assert(b && +b[1] >= 44, "search button");
  const s = coastal.match(/\.cc-location select \{[^}]*min-height: (\d+)px/); assert(s && +s[1] >= 44, "town select");
  const l = style.match(/\.partner-link \{[^}]*min-height: (\d+)px/); assert(l && +l[1] >= 44, "partner link");
});

test("home: every partner Order link deep-links a known partner (no href=#)", () => {
  const links = [...home.matchAll(/<a href="([^"]*)" class="partner-link"[^>]*>/g)].map((m) => m[1]);
  assert.strictEqual(links.length, 6);
  const names = [...home.matchAll(/<h3>([^<]+)<\/h3>\s*<p class="partner-location">/g)].map((m) => m[1]);
  links.forEach((href, i) => {
    const m = href.match(/^\/order\/\?restaurant=([a-z0-9-]+)$/);
    assert(m, "bad href " + href);
    const p = C.partnerBySlug(m[1]);
    assert(p, "unknown slug " + m[1]);
    assert.strictEqual(p.name, names[i], "slug/name mismatch for " + href);
  });
});

test("partner slugs: known slug prefills category/service/pickup town", () => {
  const p = C.parseOrderParams("?restaurant=texmexcoyote");
  assert.strictEqual(p.restaurant, "texmexcoyote");
  assert.strictEqual(p.category, "food");
  assert.strictEqual(p.service, "package_delivery");
  assert.strictEqual(p.pickup, "Port Aransas");
  assert.strictEqual(C.parseOrderParams("?restaurant=clems-bait-tackle").category, "bait");
  // North Padre Island partners use the "Padre Island" zone (see PARTNERS comment).
  assert.strictEqual(C.parseOrderParams("?restaurant=shells-seafood").pickup, "Padre Island");
  // Explicit params win.
  assert.strictEqual(C.parseOrderParams("?pickup=Rockport&restaurant=texmexcoyote").pickup, "Rockport");
});

test("partner slugs: unknown/hostile values are ignored", () => {
  ["<script>alert(1)</script>", "%3Cimg%20src%3Dx%20onerror%3Dalert(1)%3E", "texmexcoyote%22onmouseover", "../../etc", "x".repeat(300), "TEXMEXCOYOTE "]
    .forEach((v) => {
      const p = C.parseOrderParams("?restaurant=" + v);
      assert.strictEqual(p.restaurant, null, v);
      assert.strictEqual(p.category, null, v);
    });
  assert.strictEqual(C.partnerBySlug("TexMexCoyote").slug, "texmexcoyote"); // case-insensitive
});

test("order prefill writes partner name via .value/.textContent only", () => {
  const src = read("frontend/js/order.js");
  const f = src.slice(src.indexOf("function initFromUrl"), src.indexOf("function updateLiveQuote"));
  assert(/pickupAddr\.value = partner\.name/.test(f));
  assert(!/innerHTML/.test(f), "no innerHTML in initFromUrl");
});

if (failed) { console.error(failed + " failed"); process.exit(1); }
console.log("mobile-map-home tests passed");
