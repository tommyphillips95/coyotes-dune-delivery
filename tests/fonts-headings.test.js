#!/usr/bin/env node
// Fonts are self-hosted (no Google Fonts requests), only the families the
// pages show are shipped (Inter, DM Sans), with OFL license files,
// font-display: swap and a preload; the home page heading levels don't skip.
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const ROOT = path.join(__dirname, "..");
const FE = path.join(ROOT, "frontend");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
const tracked = execSync("git ls-files frontend", { cwd: ROOT, encoding: "utf8" }).split("\n").filter(Boolean);
const htmlFiles = tracked.filter((f) => f.endsWith(".html"));
const textFiles = tracked.filter((f) => /\.(html|css|js|json|webmanifest)$/.test(f));
const tests = [];
const test = (n, f) => tests.push([n, f]);

function fontFaces(css) {
  return [...css.matchAll(/@font-face\s*\{([^}]*)\}/g)].map((m) => {
    const b = m[1];
    const get = (k) => { const r = new RegExp(k + "\\s*:\\s*([^;]+);").exec(b); return r ? r[1].trim() : null; };
    return { family: (get("font-family") || "").replace(/['"]/g, ""), weight: get("font-weight"), style: get("font-style"), display: get("font-display"),
      src: (/url\(['"]?([^'")]+)['"]?\)\s*format\(['"]woff2['"]\)/.exec(b) || [])[1], range: get("unicode-range") };
  });
}

test("no Google Fonts requests anywhere in the site", () => {
  for (const f of textFiles) {
    const s = read(f);
    assert(!/fonts\.googleapis\.com|fonts\.gstatic\.com/.test(s), f + " still loads Google Fonts");
  }
});

test("only Inter and DM Sans are used; Playfair Display / Outfit are gone", () => {
  for (const f of textFiles.filter((x) => /\.(html|css|js)$/.test(x))) {
    const s = read(f);
    assert(!/font-family\s*:[^;]*(Playfair|Outfit)/i.test(s), f + " uses Playfair/Outfit");
    assert(!/--font-[a-z-]+\s*:[^;]*(Playfair|Outfit)/i.test(s), f + " defines a Playfair/Outfit stack");
    for (const m of s.matchAll(/(?:font-family|--font(?:-[a-z]+)?)\s*:\s*['"]([^'"]+)['"]/g)) {
      assert(["Inter", "DM Sans", "SF Mono"].includes(m[1]), `${f}: unexpected web font '${m[1]}'`);
    }
  }
});

test("@font-face: self-hosted woff2, font-display: swap, latin + latin-ext ranges, weights as before", () => {
  const faces = fontFaces(read("frontend/css/coastal.css"));
  assert.strictEqual(faces.length, 6);
  for (const f of faces) {
    assert.strictEqual(f.display, "swap", JSON.stringify(f));
    assert.strictEqual(f.style, "normal");
    assert(/^\.\.\/fonts\/[a-z0-9-]+\.woff2$/.test(f.src), f.src);
    const file = path.join(FE, "css", f.src);
    assert(fs.existsSync(file), f.src + " exists");
    assert.strictEqual(fs.readFileSync(file).slice(0, 4).toString("latin1"), "wOF2", f.src + " is woff2");
    assert(/^U\+/.test(f.range || ""), "unicode-range set");
  }
  const sig = faces.map((f) => `${f.family}|${f.weight}|${f.src.includes("latin-ext") ? "ext" : "latin"}`).sort();
  assert.deepStrictEqual(sig, ["DM Sans|400 500|ext", "DM Sans|400 500|latin", "DM Sans|700|ext", "DM Sans|700|latin", "Inter|400 700|ext", "Inter|400 700|latin"].sort());
  // every shipped font file is used, nothing extra
  const shipped = tracked.filter((f) => f.startsWith("frontend/fonts/") && f.endsWith(".woff2")).map((f) => path.basename(f)).sort();
  assert.deepStrictEqual(shipped, [...new Set(faces.map((f) => path.basename(f.src)))].sort());
});

test("OFL license files ship next to the fonts", () => {
  for (const [file, who] of [["frontend/fonts/Inter-OFL.txt", "The Inter Project Authors"], ["frontend/fonts/DMSans-OFL.txt", "The DM Sans Project Authors"]]) {
    const s = read(file);
    assert(s.includes(who), file);
    assert(s.includes("SIL Open Font License, Version 1.1") && s.includes("PERMISSION & CONDITIONS"), file + " is the full OFL 1.1");
  }
  assert(/OFL 1\.1: see fonts\/Inter-OFL\.txt, fonts\/DMSans-OFL\.txt/.test(read("frontend/css/coastal.css")));
});

test("every page preloads the main font file (Inter latin); home also preloads DM Sans (its LCP heading)", () => {
  const faces = fontFaces(read("frontend/css/coastal.css")).map((f) => "/fonts/" + path.basename(f.src));
  for (const f of htmlFiles) {
    const s = read(f);
    const pre = [...s.matchAll(/<link rel="preload" href="([^"]+)" as="font" type="font\/woff2" crossorigin>/g)].map((m) => m[1]);
    assert(pre.includes("/fonts/inter-v20-latin.woff2"), f + " preloads Inter");
    pre.forEach((p) => assert(faces.includes(p), f + ": preload " + p + " matches an @font-face src"));
    assert.strictEqual(pre.length, f === "frontend/index.html" ? 2 : 1, f + " preload count");
    const preAt = s.indexOf('rel="preload" href="/fonts/');
    const cssAt = s.search(/<link rel="stylesheet"|<style>/);
    assert(preAt > 0 && preAt < cssAt, f + ": preload comes before the CSS");
  }
});

test("404 page: same @font-face as the site (absolute paths), no other families", () => {
  const css = (p) => fontFaces(p).map((f) => [f.family, f.weight, path.basename(f.src), f.display, f.range].join("|"));
  const page = read("frontend/404.html");
  assert.strictEqual(fontFaces(page).length, 6, "404 declares the site fonts");
  assert.deepStrictEqual(css(page), css(read("frontend/css/coastal.css")));
  fontFaces(page).forEach((f) => assert(f.src.startsWith("/fonts/"), f.src));
});

test("fonts get a long cache header on Netlify", () => {
  assert(/\[\[headers\]\]\s*for = "\/fonts\/\*"\s*\[headers\.values\]\s*Cache-Control = "public, max-age=31536000, immutable"/.test(read("netlify.toml")));
});

test("home page: one h1, then no skipped heading levels", () => {
  const html = read("frontend/index.html");
  const levels = [...html.matchAll(/<h([1-6])\b/g)].map((m) => +m[1]);
  assert.strictEqual(levels[0], 1);
  assert.strictEqual(levels.filter((l) => l === 1).length, 1);
  levels.forEach((l, i) => { if (i) assert(l <= levels[i - 1] + 1, `h${levels[i - 1]} → h${l} at heading #${i + 1}`); });
});

test("re-levelled home headings keep their old styles (selectors cover both tags)", () => {
  const css = read("frontend/css/style.css");
  assert(/\.zone-card h3,\s*\.zone-card h4 \{/.test(css));
  assert(/\.footer-links h2,\s*\.footer-links h4 \{/.test(css));
  const html = read("frontend/index.html");
  for (const t of ["<h3>Port Aransas</h3>", "<h3>Padre Island</h3>", "<h3>Mustang Island</h3>", "<h2>Company</h2>", "<h2>Support</h2>", "<h2>Legal</h2>"]) assert(html.includes(t), t);
});

let failed = 0;
for (const [n, f] of tests) { try { f(); console.log("ok -", n); } catch (e) { failed++; console.error("not ok -", n, "\n ", e.message); } }
console.log(failed ? `${failed} failed` : `fonts-headings: ${tests.length} passed`);
process.exit(failed ? 1 : 0);
