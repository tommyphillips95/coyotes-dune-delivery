#!/usr/bin/env node
/**
 * One backend (#11): Netlify Functions + Supabase only.
 *  - Express leftover is quarantined (legacy/express-backend), not reachable.
 *  - One order contract: create-order; /api/submit-order is a netlify.toml alias.
 *  - Every /api/* call the frontend makes resolves to a real function, except
 *    the documented Express-era gaps in docs/backend.md (no new ones allowed).
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
const exists = (p) => fs.existsSync(path.join(ROOT, p));

let passed = 0;
function test(name, fn) { fn(); passed++; console.log("  ok - " + name); }

function walk(dir, exts, out = []) {
  for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== "node_modules") walk(p, exts, out); }
    else if (exts.some((x) => p.endsWith(x))) out.push(p);
  }
  return out;
}

// netlify.toml redirects, in order (first match wins, like Netlify).
function redirects() {
  const toml = read("netlify.toml");
  const out = [];
  const re = /\[\[redirects\]\]\s*\n\s*from\s*=\s*"([^"]+)"\s*\n\s*to\s*=\s*"([^"]+)"/g;
  let m;
  while ((m = re.exec(toml))) out.push({ from: m[1], to: m[2] });
  return out;
}
const FUNCS = new Set(fs.readdirSync(path.join(ROOT, "netlify/functions")).filter((f) => f.endsWith(".js") && !f.startsWith("_")).map((f) => f.slice(0, -3)));

/** Which function would Netlify invoke for this /api path? null if none. */
function resolveApi(apiPath) {
  for (const r of redirects()) {
    const prefix = r.from.endsWith("/*") ? r.from.slice(0, -1) : null;
    const hit = prefix ? apiPath.startsWith(prefix) : apiPath === r.from;
    if (!hit) continue;
    if (!r.to.startsWith("/.netlify/functions/")) return null;
    const target = r.to.replace("/.netlify/functions/", "").replace(":splat", prefix ? apiPath.slice(prefix.length) : "");
    const fn = target.split(/[/?]/)[0];
    return FUNCS.has(fn) ? fn : null;
  }
  return null;
}

// Express-era call sites with no matching function yet. Documented in
// docs/backend.md; each needs a decision from Tommy before porting.
const KNOWN_GAPS = new Set(["/api/admin", "/api/admin/login", "/api/admin/applications", "/api/admin/applications/bulk"]);

/** Collect every /api path the frontend calls (literals + API_BASE helpers). */
function frontendApiCalls() {
  const calls = new Set();
  for (const f of walk("frontend", [".js", ".html"])) {
    const src = read(f);
    for (const m of src.matchAll(/['"`](\/api\/[a-z0-9\-/]+)/gi)) calls.add(m[1].replace(/\/$/, ""));
    const base = /API_BASE\s*=\s*['"](\/api[^'"]*)['"]/.exec(src);
    if (base) {
      for (const m of src.matchAll(/api\(\s*'[A-Z]+'\s*,\s*[`'](\/[a-z0-9\-/]+)/gi)) calls.add(base[1] + m[1].replace(/\/$/, ""));
      for (const m of src.matchAll(/API_BASE\s*\+\s*'(\/[a-z0-9\-]+)/gi)) calls.add(base[1] + m[1]);
      for (const m of src.matchAll(/\$\{API_BASE\}(\/[a-z0-9\-]+)/gi)) calls.add(base[1] + m[1]);
    }
    for (const m of src.matchAll(/apiGet\(\s*'([a-z0-9\-]+)/gi)) calls.add("/api/" + m[1]);
  }
  calls.delete("/api");
  return [...calls].sort();
}

console.log("single-backend.test.js");

test("Express leftover is quarantined, not at backend/", () => {
  assert.ok(!exists("backend"), "backend/ must not exist at the repo root");
  assert.ok(exists("legacy/express-backend/README.md"));
  assert.ok(/QUARANTINED/.test(read("legacy/express-backend/README.md")));
  assert.ok(!exists("legacy/express-backend/server.js"), "do not revive the Express server");
});

test("nothing deployable references the Express leftover", () => {
  for (const f of [...walk("netlify/functions", [".js"]), ...walk("frontend", [".js", ".html"]), ...walk("scripts", [".js", ".sh"]), "netlify.toml", "package.json"]) {
    const src = read(f);
    assert.ok(!/legacy\/express-backend|require\(['"][./]*backend\//.test(src), f);
    assert.ok(!/require\(['"]express['"]\)/.test(src), f + " requires express");
  }
  const pkg = JSON.parse(read("package.json"));
  assert.ok(!(pkg.dependencies || {}).express, "express is not a production dependency");
});

test("netlify.toml serves frontend/ + netlify/functions only", () => {
  const toml = read("netlify.toml");
  assert.ok(/publish\s*=\s*"frontend"/.test(toml));
  assert.ok(/functions\s*=\s*"netlify\/functions"/.test(toml));
});

test("one order contract: create-order; submit-order is only a redirect", () => {
  assert.ok(!exists("netlify/functions/submit-order.js"), "no second order function");
  assert.ok(FUNCS.has("create-order"));
  assert.strictEqual(resolveApi("/api/submit-order"), "create-order");
  assert.strictEqual(resolveApi("/api/create-order"), "create-order");
  const rs = redirects();
  const alias = rs.findIndex((r) => r.from === "/api/submit-order");
  const catchAll = rs.findIndex((r) => r.from === "/api/*");
  assert.ok(alias > -1 && alias < catchAll, "alias must precede the /api/* catch-all");
  for (const f of walk("frontend", [".js", ".html"])) {
    assert.ok(!/fetch\([^)]*submit-order|post\([^)]*submit-order/i.test(read(f)), f + " calls submit-order");
  }
});

test("redirect resolver sanity", () => {
  assert.strictEqual(resolveApi("/api/checkr/candidates"), "checkr");
  assert.strictEqual(resolveApi("/api/get-orders"), "get-orders");
  assert.strictEqual(resolveApi("/api/does-not-exist"), null);
});

test("every frontend /api call hits a real function (or a documented gap)", () => {
  const calls = frontendApiCalls();
  assert.ok(calls.length > 10, "found " + calls.length + " calls");
  const missing = calls.filter((c) => !resolveApi(c) && !KNOWN_GAPS.has(c));
  assert.deepStrictEqual(missing, [], "unrouted frontend calls: " + missing.join(", "));
  const docs = read("docs/backend.md");
  for (const g of KNOWN_GAPS) {
    assert.ok(!resolveApi(g), g + " is now routed; drop it from KNOWN_GAPS");
    assert.ok(docs.includes(g.replace(/\/(bulk)$/, "")), g + " documented in docs/backend.md");
  }
});

console.log(`single-backend: ${passed} passed`);
