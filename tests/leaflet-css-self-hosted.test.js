#!/usr/bin/env node
// Tracking page: Leaflet CSS is served from our own origin (no render-blocking
// third-party stylesheet). The vendored file must be byte-identical to the
// published leaflet@1.9.4 dist/leaflet.css, and every image it or Leaflet's
// default marker icon references must be present, along with the license.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const root = path.join(__dirname, "..", "frontend");
const dir = path.join(root, "vendor/leaflet-1.9.4");
const html = fs.readFileSync(path.join(root, "track/index.html"), "utf8");
const sha = (f) => crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex");
const exists = (f) => fs.existsSync(path.join(dir, f));
const tests = [
  ["no unpkg stylesheet on /track/", !/<link[^>]+unpkg\.com[^>]+leaflet\.css/.test(html)],
  ["/track/ links the self-hosted Leaflet CSS", html.includes('<link rel="stylesheet" href="/vendor/leaflet-1.9.4/leaflet.css"/>')],
  ["leaflet.css matches leaflet@1.9.4 (sha256)", exists("leaflet.css") && sha(path.join(dir, "leaflet.css")) === "a7837102824184820dfa198d1ebcd109ff6d0ff9a2672a074b9a1b4d147d04c6"],
  ["BSD-2-Clause LICENSE shipped with it", exists("LICENSE") && /BSD 2-Clause License[\s\S]*Volodymyr Agafonkin/.test(fs.readFileSync(path.join(dir, "LICENSE"), "utf8"))],
];
for (const img of ["layers.png", "layers-2x.png", "marker-icon.png", "marker-icon-2x.png", "marker-shadow.png"]) {
  tests.push(["images/" + img + " present", exists("images/" + img)]);
}
let pass = 0;
for (const [name, ok] of tests) { console.log((ok ? "ok - " : "not ok - ") + name); if (ok) pass++; }
console.log(pass + "/" + tests.length + " passed");
process.exit(pass === tests.length ? 0 : 1);
