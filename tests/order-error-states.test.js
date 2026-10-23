#!/usr/bin/env node
/**
 * Order page error states (browser-checked at 375px; these pin the wiring):
 * - a 200 from create-order with no readable order (proxy page, cut-off body)
 *   must not show "Order Confirmed" with a blank order number;
 * - the "Track an Existing Order" box can't hang on "Tracking..." (timeout);
 * - a 200 lookup answer that isn't JSON says "try again", not "not found".
 */
"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const ROOT = path.join(__dirname, "..");
const src = fs.readFileSync(path.join(ROOT, "frontend/js/order.js"), "utf8");
const C = require(path.join(ROOT, "frontend/js/coastal.js"));
const body = (name) => {
  const s = src.indexOf(`function ${name}(`);
  assert.ok(s > -1, name);
  const e = [src.indexOf("\n    function ", s + 10), src.indexOf("\n    async function ", s + 10)].filter((i) => i > -1);
  return src.slice(s, e.length ? Math.min(...e) : undefined);
};
const tests = [];
const test = (n, f) => tests.push([n, f]);

test("submitOrder: unreadable 200 becomes a 'may have gone through' failure before any success path", () => {
  const b = body("submitOrder");
  const guard = b.search(/if \(result\.ok && !\(result\.data && typeof result\.data === 'object' && result\.data\.orderNumber && result\.data\.orderId\)\)/);
  assert.ok(guard > -1, "guard present");
  assert.ok(guard < b.indexOf("networkFailureKind(result)"), "before the retry decision");
  assert.ok(guard < b.indexOf("if (result.ok) {"), "before showSuccess / card form");
  const rewritten = /result = \{ ok: false, status: 0, error: 'unreadable response', timedOut: true, network: true \}/.test(b);
  assert.ok(rewritten);
  // That result maps to the existing Retry-safe timeout copy (no new text).
  const r = { ok: false, status: 0, error: "unreadable response", timedOut: true, network: true };
  assert.strictEqual(C.networkFailureKind(r), "timeout");
  assert.match(C.orderErrorMessage(r), /may already have gone through/);
});

test("trackOrder: both get-orders calls have a timeout", () => {
  const b = body("trackOrder");
  assert.ok(/CoyoteAPI\.post\('\/api\/get-orders', \{[^}]*\}, \{ timeoutMs \}\)/.test(b));
  assert.ok(/CoyoteAPI\.request\('\/api\/get-orders', \{[\s\S]*?timeoutMs\s*\}\)/.test(b));
  assert.strictEqual(C.trackErrorMessage({ ok: false, status: 0, timedOut: true }), "We couldn't reach Coyote's servers. Check your signal and try again.");
});

test("trackOrder: non-JSON 200 says try again, before the not-found branch", () => {
  const b = body("trackOrder");
  const i = b.search(/if \(auth\.ok && \(!auth\.data \|\| typeof auth\.data !== 'object'\)\) \{\s*trackMessage\(trackErrorMessage\(\{ ok: false, status: 500 \}\)\)/);
  assert.ok(i > -1);
  assert.ok(i < b.indexOf("if (!auth.ok || !auth.data || !auth.data.token)"));
});

let failed = 0;
for (const [n, f] of tests) { try { f(); console.log("ok -", n); } catch (e) { failed++; console.log("not ok -", n, "\n ", e.message); } }
if (failed) process.exit(1);
