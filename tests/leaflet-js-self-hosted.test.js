#!/usr/bin/env node
// Tracking page: Leaflet JS is served from our own origin (no third-party
// script). The vendored file must match leaflet@1.9.4 dist/leaflet.js.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const root = path.join(__dirname, "..", "frontend");
const dir = path.join(root, "vendor/leaflet-1.9.4");
const html = fs.readFileSync(path.join(root, "track/index.html"), "utf8");
const sha = (f) => crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex");
const exists = (f) => fs.existsSync(path.join(dir, f));
const EXPECT = "db49d009c841f5ca34a888c96511ae936fd9f5533e90d8b2c4d57596f4e5641a";
const tests = [
  ["no unpkg leaflet.js on /track/", !/<script[^>]+unpkg\.com[^>]+leaflet\.js/.test(html)],
  ["/track/ loads the self-hosted Leaflet JS", html.includes('<script defer src="/vendor/leaflet-1.9.4/leaflet.js"></script>')],
  ["leaflet.js matches leaflet@1.9.4 (sha256)", exists("leaflet.js") && sha(path.join(dir, "leaflet.js")) === EXPECT],
  ["BSD-2-Clause LICENSE still shipped", exists("LICENSE") && /BSD 2-Clause License[\s\S]*Volodymyr Agafonkin/.test(fs.readFileSync(path.join(dir, "LICENSE"), "utf8"))],
];
let pass = 0;
for (const [name, ok] of tests) { console.log((ok ? "ok - " : "not ok - ") + name); if (ok) pass++; }
console.log(pass + "/" + tests.length + " passed");
process.exit(pass === tests.length ? 0 : 1);
