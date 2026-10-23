#!/usr/bin/env node
// Track map: pickup and dropoff pins are focusable images. Leaflet's default
// alt text is "Marker", so a screen reader heard "Marker, Marker" with no way
// to tell them apart. Each pin now gets its own alt text and title.
// Checked in a browser with real Leaflet 1.9.4 (img alt/title).
const fs = require("fs");
const path = require("path");
const src = fs.readFileSync(path.join(__dirname, "..", "frontend/track/track.js"), "utf8");
const tests = [
  ["pickup pin has alt 'Pickup location'", /pickupMarker = L\.marker\([^;]*\{[^}]*alt: "Pickup location"/],
  ["dropoff pin has alt 'Dropoff location'", /dropoffMarker = L\.marker\([^;]*\{[^}]*alt: "Dropoff location"/],
  ["pins have hover titles", /alt: "Pickup location", title: "Pickup"[\s\S]*alt: "Dropoff location", title: "Dropoff"/],
];
let pass = 0;
for (const [name, re] of tests) { const ok = re.test(src); console.log((ok ? "ok - " : "not ok - ") + name); if (ok) pass++; }
console.log(pass + "/" + tests.length + " passed");
process.exit(pass === tests.length ? 0 : 1);
