#!/usr/bin/env node
// Site icons: every page links a favicon, apple-touch-icon and manifest that
// exist (the home page used to log a /favicon.ico 404), built from the nav
// logo already in index.html (no new branding).
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const FE = path.join(__dirname, "..", "frontend");
const read = (p) => fs.readFileSync(path.join(FE, p), "utf8");
const pages = [];
(function walk(d) { for (const e of fs.readdirSync(path.join(FE, d), { withFileTypes: true })) {
  const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (e.name.endsWith(".html")) pages.push(p);
} })("");
function png(p) {
  const b = fs.readFileSync(path.join(FE, p));
  assert.strictEqual(b.toString("ascii", 1, 4), "PNG", p + " is a PNG");
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20), alpha: b[25] === 6 };
}
const tests = [];
const test = (n, f) => tests.push([n, f]);

test("every page links favicon.ico, favicon.svg, apple-touch-icon, manifest, theme-color", () => {
  assert(pages.length >= 9, "found " + pages.length + " pages");
  for (const p of pages) {
    const h = read(p).split("</head>")[0];
    for (const tag of ['rel="icon" href="/favicon.ico"', 'rel="icon" href="/favicon.svg" type="image/svg+xml"', 'rel="apple-touch-icon" href="/apple-touch-icon.png"', 'rel="manifest" href="/site.webmanifest"', 'name="theme-color" content="#10202E"']) {
      assert(h.includes(tag), p + " head has " + tag);
    }
  }
});

test("icon files exist with the right sizes", () => {
  const ico = fs.readFileSync(path.join(FE, "favicon.ico"));
  assert.strictEqual(ico.readUInt16LE(2), 1, "ICO type");
  const sizes = []; for (let i = 0; i < ico.readUInt16LE(4); i++) sizes.push(ico[6 + i * 16] || 256);
  assert.deepStrictEqual(sizes.sort((a, b) => a - b), [16, 32, 48]);
  assert.deepStrictEqual(png("apple-touch-icon.png"), { w: 180, h: 180, alpha: false }, "opaque 180 (iOS fills transparency with black)");
  assert.deepStrictEqual([png("assets/icon-192.png").w, png("assets/icon-512.png").w], [192, 512]);
  const badge = png("assets/icon-72.png"); assert(badge.w === 72 && badge.alpha, "notification badge is 72px with transparency");
});

test("manifest is valid and its icons exist", () => {
  const m = JSON.parse(read("site.webmanifest"));
  assert.strictEqual(m.name, "Coyote's Dune Delivery");
  assert.strictEqual(m.start_url, "/");
  for (const i of m.icons) assert(fs.existsSync(path.join(FE, i.src)), i.src);
  assert(m.icons.some((i) => i.sizes === "512x512") && m.icons.some((i) => i.sizes === "192x192"));
});

test("push notification icon paths now resolve", () => {
  const refs = new Set();
  for (const f of ["firebase-messaging-sw.js", "js/firebase-messaging.js"]) for (const m of read(f).matchAll(/'(\/assets\/[^']+\.png)'/g)) refs.add(m[1]);
  assert(refs.size >= 2, "found " + [...refs]);
  for (const r of refs) assert(fs.existsSync(path.join(FE, r)), r);
});

test("favicon.svg is the existing nav logo (same paths, brand coral on ink)", () => {
  const nav = /<svg class="logo-icon"[\s\S]*?<\/svg>/.exec(read("index.html"))[0];
  const paths = (s) => [...s.matchAll(/<path d="([^"]+)"/g)].map((m) => m[1]);
  const svg = read("favicon.svg");
  assert.deepStrictEqual(paths(svg), paths(nav));
  assert(/stroke="#FF6B4A"/.test(svg) && /fill="#10202E"/.test(svg));
  const css = fs.readFileSync(path.join(FE, "css/coastal.css"), "utf8");
  assert(/--cc-coral: #FF6B4A/.test(css) && /--cc-ink: #10202E/.test(css), "colours are the brand variables");
});

let failed = 0;
for (const [n, f] of tests) { try { f(); console.log("ok -", n); } catch (e) { failed++; console.error("not ok -", n, "\n ", e.message); } }
console.log(failed ? `${failed} failed` : `site-icons: ${tests.length} passed`);
process.exit(failed ? 1 : 0);
