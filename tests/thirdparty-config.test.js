#!/usr/bin/env node
// Google Analytics / Firebase only load with real config, and the push SDK
// never blocks first paint. Placeholder IDs ('G-XXXXXXXXXX',
// 'YOUR_FIREBASE_API_KEY') used to download ~320 KB and hit Google with a
// fake key (400 API_KEY_INVALID) on every page. Runs the real files in a vm.
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const ROOT = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");

function sandbox(globals) {
  const appended = [];
  const warns = [];
  const el = (tag) => ({ tagName: tag, set src(v) { this._src = v; }, get src() { return this._src; }, style: {}, appendChild() {}, remove() {} });
  const document = {
    readyState: "complete",
    head: { appendChild: (n) => { appended.push(n); } },
    body: { appendChild: () => {} },
    createElement: el,
    getElementById: () => null,
    querySelector: () => null,
    addEventListener: () => {},
  };
  const storage = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }; };
  const win = Object.assign({ document, sessionStorage: storage(), localStorage: storage(), location: { pathname: "/", href: "http://x/" }, navigator: {}, addEventListener() {} }, globals || {});
  win.window = win;
  const ctx = vm.createContext(Object.assign(win, {
    console: { log() {}, warn: (...a) => warns.push(a.join(" ")), error: (...a) => warns.push(a.join(" ")) },
    setTimeout, clearTimeout, Date, Math, JSON, Promise, fetch: async () => ({ ok: true, json: async () => ({}) }),
  }));
  return { ctx, appended, warns, run: (file) => vm.runInContext(read(file), ctx, { filename: file }) };
}
const srcs = (s) => s.appended.map((n) => n._src).filter(Boolean);
const tests = [];
const test = (n, f) => tests.push([n, f]);

test("GA: placeholder ID -> no gtag.js, trackEvent is a silent no-op", () => {
  const s = sandbox({ __GA4_ID__: "G-XXXXXXXXXX" });
  s.run("frontend/js/analytics.js");
  assert.deepStrictEqual(srcs(s).filter((u) => /googletagmanager/.test(u)), []);
  assert.strictEqual(s.ctx.__CDD_GA_CONFIGURED__, false);
  s.ctx.trackEvent("order", "submitted", "ride", 25);
  s.ctx.trackConversion("purchase", { value: 25 });
  assert.deepStrictEqual(s.warns.filter((w) => /gtag not ready/.test(w)), []);
});

test("GA: real-looking ID still loads gtag.js", () => {
  const s = sandbox({ __GA4_ID__: "G-AB12CD34EF" });
  s.run("frontend/js/analytics.js");
  assert(srcs(s).some((u) => /googletagmanager\.com\/gtag\/js\?id=G-AB12CD34EF/.test(u)), JSON.stringify(srcs(s)));
});

test("Firebase Analytics: placeholder config -> SDK not downloaded", () => {
  const s = sandbox({});
  s.run("frontend/js/firebase-analytics.js");
  assert.deepStrictEqual(srcs(s).filter((u) => /gstatic\.com\/firebasejs/.test(u)), []);
  assert.strictEqual(s.ctx.__CDD_FIREBASE_ANALYTICS_CONFIGURED__, false);
  s.ctx.firebaseTrackEvent("x", {}); // no-op, no throw
  const c = sandbox({ __FIREBASE_API_KEY__: "AIzaTestKeyNotReal", __FIREBASE_PROJECT_ID__: "cdd-test" });
  c.run("frontend/js/firebase-analytics.js");
  assert(srcs(c).some((u) => /firebase-app-compat\.js/.test(u)));
});

function fakeFirebase(log) {
  return {
    initializeApp: (cfg) => { log.push(["init", cfg.projectId]); return {}; },
    messaging: () => ({ onMessage() {}, getToken: async (o) => { log.push(["getToken", o]); return "tok_test_123456789012345"; }, deleteToken: async () => true }),
  };
}

test("FCM: placeholder config -> no init, no service worker registration", async () => {
  const log = [];
  const s = sandbox({ firebase: fakeFirebase(log), navigator: { serviceWorker: { register: async () => { log.push(["sw"]); return {}; } } } });
  s.ctx.firebase = s.ctx.firebase; // global
  s.run("frontend/js/firebase-messaging.js");
  await new Promise((r) => setTimeout(r, 10));
  assert.deepStrictEqual(log, []);
});

test("FCM: configured -> init works on SDK 10 (no useServiceWorker); SW registration goes to getToken", async () => {
  const log = [];
  const reg = { scope: "/" };
  const s = sandbox({
    __FIREBASE_API_KEY__: "AIzaTestKeyNotReal", __FIREBASE_PROJECT_ID__: "cdd-test", __FIREBASE_VAPID_KEY__: "BTestVapidKey",
    firebase: fakeFirebase(log), Notification: { requestPermission: async () => "granted" },
    navigator: { serviceWorker: { register: async () => reg } },
  });
  s.run("frontend/js/firebase-messaging.js");
  await new Promise((r) => setTimeout(r, 10));
  assert.deepStrictEqual(log[0], ["init", "cdd-test"]);
  assert(!s.warns.some((w) => /Failed to initialize/.test(w)), s.warns.join("\n"));
  const tok = await s.ctx.CoyoteFCM.getToken();
  assert.strictEqual(tok, "tok_test_123456789012345");
  const opts = log.find((l) => l[0] === "getToken")[1];
  assert.strictEqual(opts.vapidKey, "BTestVapidKey");
  assert.strictEqual(opts.serviceWorkerRegistration, reg);
});

test("home page: no static Firebase CDN; firebase-messaging.js is deferred", () => {
  const html = read("frontend/index.html");
  const tags = [...html.matchAll(/<script\b[^>]*src="([^"]+)"[^>]*>/g)].map((m) => ({ tag: m[0], src: m[1] }));
  assert.deepStrictEqual(tags.filter((t) => /gstatic\.com\/firebasejs/.test(t.src)).map((t) => t.src), []);
  const msg = tags.filter((t) => /firebase-messaging\.js$/.test(t.src));
  assert.strictEqual(msg.length, 1);
  assert(/\sdefer[\s>]/.test(msg[0].tag), msg[0].tag);
});

test("FCM SW: placeholder config does not importScripts Firebase CDN", () => {
  const sw = read("frontend/firebase-messaging-sw.js");
  // Guard must short-circuit before importScripts when YOUR_* remains.
  assert(/CONFIGURED/.test(sw));
  assert(/if \(!CONFIGURED\)/.test(sw));
  // importScripts only inside the configured branch (after the CONFIGURED check).
  const idxConfigured = sw.indexOf("const CONFIGURED");
  const idxImport = sw.indexOf("importScripts(");
  assert(idxConfigured >= 0 && idxImport > idxConfigured, "importScripts must follow CONFIGURED gate");
  assert(/YOUR_FIREBASE_API_KEY/.test(sw));
});

test("FCM: placeholder sets __CDD_FIREBASE_MESSAGING_CONFIGURED__ false", () => {
  const s = sandbox({});
  s.run("frontend/js/firebase-messaging.js");
  assert.strictEqual(s.ctx.__CDD_FIREBASE_MESSAGING_CONFIGURED__, false);
  assert.deepStrictEqual(srcs(s).filter((u) => /gstatic\.com\/firebasejs/.test(u)), []);
});

(async () => {
  let failed = 0;
  for (const [n, f] of tests) { try { await f(); console.log("ok - " + n); } catch (e) { failed++; console.error("not ok - " + n + "\n  " + e.message); } }
  if (failed) { console.error(failed + " failed"); process.exit(1); }
  console.log("thirdparty-config tests passed");
})();
