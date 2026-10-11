#!/usr/bin/env node
/**
 * Driver offer/GPS endpoint auth (#6). No network — exercises _auth helpers
 * and static guards on the Netlify functions + portal callers.
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const jwt = require("jsonwebtoken");

const authPath = path.join(__dirname, "..", "netlify/functions/_auth.js");
const {
  requireAdmin,
  requireDriver,
  requireAdminOrDriver,
  requireAdminOrInternal,
  requireLocationCaller,
  assertLocationAccess,
  issueDriverToken,
  isNetlifySchedule,
} = require(authPath);

let failed = 0;
function check(name, fn) {
  try {
    fn();
    console.log("ok -", name);
  } catch (e) {
    failed++;
    console.error("FAIL -", name, e && e.message ? e.message : e);
  }
}

function eventWithAuth(token, extraHeaders) {
  const headers = Object.assign({}, extraHeaders || {});
  if (token) headers.authorization = "Bearer " + token;
  return { headers, httpMethod: "GET" };
}

const SECRET = "test-jwt-secret-for-driver-auth-32b";
const prev = process.env.JWT_SECRET;
process.env.JWT_SECRET = SECRET;

check("issueDriverToken signs role=driver", () => {
  const t = issueDriverToken("drv-1");
  const d = jwt.verify(t, SECRET);
  assert.strictEqual(d.role, "driver");
  assert.strictEqual(d.driver_id, "drv-1");
});

check("requireDriver accepts driver JWT", () => {
  const t = issueDriverToken("drv-2");
  const d = requireDriver(eventWithAuth(t));
  assert.strictEqual(d.driver_id, "drv-2");
});

check("requireDriver rejects admin JWT", () => {
  const t = jwt.sign({ role: "admin", user: "a" }, SECRET);
  let threw = false;
  try {
    requireDriver(eventWithAuth(t));
  } catch (e) {
    threw = true;
    assert.strictEqual(e.status, 403);
  }
  assert.ok(threw);
});

check("requireAdminOrDriver accepts either role", () => {
  const dTok = issueDriverToken("drv-3");
  const aTok = jwt.sign({ role: "admin", user: "a" }, SECRET);
  assert.strictEqual(requireAdminOrDriver(eventWithAuth(dTok)).kind, "driver");
  assert.strictEqual(requireAdminOrDriver(eventWithAuth(aTok)).kind, "admin");
});

check("requireAdminOrDriver rejects missing token", () => {
  delete process.env.JWT_SECRET;
  process.env.JWT_SECRET = SECRET;
  let threw = false;
  try {
    requireAdminOrDriver(eventWithAuth(null));
  } catch (e) {
    threw = true;
    assert.strictEqual(e.status, 401);
  }
  assert.ok(threw);
});

check("requireAdminOrDriver fails closed without JWT_SECRET", () => {
  delete process.env.JWT_SECRET;
  let threw = false;
  try {
    requireAdminOrDriver(eventWithAuth(jwt.sign({ role: "driver", driver_id: "x" }, SECRET)));
  } catch (e) {
    threw = true;
    assert.strictEqual(e.status, 500);
  }
  assert.ok(threw);
  process.env.JWT_SECRET = SECRET;
});

check("requireAdminOrInternal allows Netlify schedule header", () => {
  const ev = { headers: { "x-netlify-event": "schedule" } };
  assert.ok(isNetlifySchedule(ev));
  assert.strictEqual(requireAdminOrInternal(ev).kind, "schedule");
});

check("requireAdminOrInternal allows internal secret", () => {
  process.env.INTERNAL_FUNCTION_SECRET = "s3cret";
  const ev = { headers: { "x-internal-secret": "s3cret" } };
  assert.strictEqual(requireAdminOrInternal(ev).kind, "internal");
  delete process.env.INTERNAL_FUNCTION_SECRET;
});

check("requireAdminOrInternal rejects bare HTTP", () => {
  let threw = false;
  try {
    requireAdminOrInternal({ headers: {} });
  } catch (e) {
    threw = true;
    assert.ok(e.status === 401 || e.status === 500);
  }
  assert.ok(threw);
});

check("assertLocationAccess: customer must match order_id", () => {
  const auth = {
    kind: "customer",
    decoded: { role: "customer", order_id: "ord-1" },
  };
  assertLocationAccess(auth, { driver_id: "d1", order_id: "ord-1" });
  let threw = false;
  try {
    assertLocationAccess(auth, { driver_id: "d1", order_id: "ord-other" });
  } catch (e) {
    threw = true;
    assert.strictEqual(e.status, 403);
  }
  assert.ok(threw);
});

check("assertLocationAccess: driver must match driver_id", () => {
  const auth = {
    kind: "driver",
    decoded: { role: "driver", driver_id: "drv-9" },
  };
  assertLocationAccess(auth, { driver_id: "drv-9", order_id: "o" });
  let threw = false;
  try {
    assertLocationAccess(auth, { driver_id: "other", order_id: "o" });
  } catch (e) {
    threw = true;
    assert.strictEqual(e.status, 403);
  }
  assert.ok(threw);
});

check("requireLocationCaller accepts customer tracking token", () => {
  const t = jwt.sign({ role: "customer", order_id: "ord-z", order_number: "CDD-1" }, SECRET);
  const auth = requireLocationCaller(eventWithAuth(t));
  assert.strictEqual(auth.kind, "customer");
});

const root = path.join(__dirname, "..");
const files = [
  "netlify/functions/respond-offer.js",
  "netlify/functions/pending-offer.js",
  "netlify/functions/update-driver-location.js",
  "netlify/functions/get-driver-location.js",
  "netlify/functions/offer-next.js",
  "netlify/functions/expire-offers.js",
  "netlify/functions/get-status.js",
  "frontend/driver/driver.js",
  "frontend/js/driver-offer.js",
];

for (const rel of files) {
  check("syntax + auth wiring: " + rel, () => {
    const src = fs.readFileSync(path.join(root, rel), "utf8");
    require("child_process").execFileSync(process.execPath, ["--check", path.join(root, rel)]);
    if (rel.startsWith("netlify/functions/") && !rel.endsWith("get-status.js")) {
      assert.ok(src.includes("_auth"), rel + " should require _auth");
    }
    if (rel === "netlify/functions/update-driver-location.js") {
      assert.ok(!src.includes("Access-Control-Allow-Origin': '*'"), "update-driver-location must not use wildcard CORS");
      assert.ok(src.includes("_cors"), "update-driver-location must use _cors");
    }
    if (rel === "netlify/functions/get-status.js") {
      assert.ok(src.includes("issueDriverToken"));
    }
    if (rel === "frontend/js/driver-offer.js") {
      assert.ok(src.includes("Authorization"));
      assert.ok(!/pending-offer\?/.test(src) || src.includes("Bearer"));
    }
    if (rel === "frontend/driver/driver.js") {
      assert.ok(src.includes("session.token"));
    }
  });
}

if (prev === undefined) delete process.env.JWT_SECRET;
else process.env.JWT_SECRET = prev;

if (failed) {
  console.error(failed + " failed");
  process.exit(1);
}
console.log("All driver-endpoint-auth checks passed.");
