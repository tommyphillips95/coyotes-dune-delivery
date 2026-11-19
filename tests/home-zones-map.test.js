#!/usr/bin/env node
// Home "Delivery Zones": a real Leaflet map of the coast (self-hosted Leaflet,
// lazy-loaded) replaces the old blob illustration. Zone ids must match the
// beach hubs in zones.js so the map never advertises a town we can't price.
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const root = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");
const M = require(path.join(root, "frontend/js/home-zones-map.js"));
const Z = require(path.join(root, "frontend/js/zones.js"));
let failed = 0;
function test(name, fn) { try { fn(); console.log("ok - " + name); } catch (e) { failed++; console.error("not ok - " + name + "\n  " + e.message); } }

const home = read("frontend/index.html");
const js = read("frontend/js/home-zones-map.js");
const hubs = (Z.ZONES || Z).hubs;

test("home: illustration markup is gone, map mount + text fallback present", () => {
  assert(!/map-illustration|map-island|bridge-label/.test(home), "old illustration still in index.html");
  assert(/id="zoneMap"[^>]*role="region"[^>]*aria-label="/.test(home), "map mount with label");
  assert(/class="zone-map-fallback"/.test(home), "no-JS fallback text");
  assert(/<script defer src="js\/home-zones-map\.js"><\/script>/.test(home), "deferred script");
});

test("leaflet is self-hosted and lazy (no leaflet tag in the home <head>, no CDN)", () => {
  assert(!/leaflet/i.test(home.replace(/home-zones-map/g, "")), "leaflet referenced directly in index.html");
  assert(/"\/vendor\/leaflet-1\.9\.4\/"/.test(js), "vendor path");
  assert(!/unpkg|cdnjs|jsdelivr/.test(js), "no CDN");
  assert(/IntersectionObserver/.test(js), "lazy load");
});

test("every map zone is a beach hub in zones.js and has a card on the page", () => {
  assert.strictEqual(M.ZONES.length, 3);
  M.ZONES.forEach((z) => {
    const hub = hubs.find((h) => h.id === z.id);
    assert(hub && hub.beach === true, "not a beach hub: " + z.id);
    assert(home.includes('class="zone-card" data-zone="' + z.id + '"'), "no card for " + z.id);
  });
});

test("zone shapes stay on the Coastal Bend barrier islands and run north -> south", () => {
  M.ZONES.forEach((z) => {
    for (let i = 1; i < z.gulf.length; i++) assert(z.gulf[i][0] < z.gulf[i - 1][0], z.id + " not north->south");
    M.zonePolygon(z).forEach(([lat, lng]) => {
      assert(lat > 27.40 && lat < 27.90 && lng > -97.35 && lng < -97.00, z.id + " point off the coast: " + lat + "," + lng);
    });
    assert.strictEqual(M.zonePolygon(z).length, z.gulf.length * 2);
  });
  M.LANDMARKS.forEach(([name, lat, lng]) => assert(lat > 27.40 && lat < 27.90 && lng > -97.35 && lng < -97.00, name));
});

test("map credits OpenStreetMap and keeps one-finger page scroll on touch", () => {
  assert(/openstreetmap\.org\/copyright/.test(js), "attribution");
  assert(/scrollWheelZoom: false, dragging: !touch/.test(js), "touch behaviour");
});

if (failed) { console.error(failed + " failed"); process.exit(1); }
console.log("home-zones-map tests passed");
