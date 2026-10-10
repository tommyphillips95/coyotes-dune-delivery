#!/usr/bin/env node
/**
 * Payment hardening unit tests (no live Stripe / network).
 * Covers amount-from-order and Netlify base64 raw-body handling.
 */
const assert = require("assert");
const path = require("path");
const crypto = require("crypto");

const stripePath = path.join(__dirname, "..", "netlify/functions/_stripe.js");
const {
  rawBody,
  resolveChargeAmountCents,
  getStripe,
  constructWebhookEvent,
} = require(stripePath);

let failed = 0;
function check(name, fn) {
  try {
    fn();
    console.log("ok -", name);
  } catch (e) {
    failed++;
    console.error("FAIL -", name, e.message);
  }
}

check("resolveChargeAmountCents uses estimated_price", () => {
  const cents = resolveChargeAmountCents({ estimated_price: 35 }, undefined);
  assert.strictEqual(cents, 3500);
});

check("resolveChargeAmountCents accepts matching client amount", () => {
  const cents = resolveChargeAmountCents({ estimated_price: 27.0 }, 27);
  assert.strictEqual(cents, 2700);
});

check("resolveChargeAmountCents rejects mismatched client amount", () => {
  let threw = false;
  try {
    resolveChargeAmountCents({ estimated_price: 35 }, 0.01);
  } catch (e) {
    threw = true;
    assert.strictEqual(e.status, 400);
  }
  assert.ok(threw);
});

check("resolveChargeAmountCents rejects missing estimated_price", () => {
  let threw = false;
  try {
    resolveChargeAmountCents({ estimated_price: null }, 10);
  } catch (e) {
    threw = true;
    assert.strictEqual(e.status, 400);
  }
  assert.ok(threw);
});

check("rawBody returns plain string when not base64", () => {
  assert.strictEqual(rawBody({ body: '{"a":1}', isBase64Encoded: false }), '{"a":1}');
});

check("rawBody decodes isBase64Encoded bodies", () => {
  const raw = '{"hello":"stripe"}';
  const b64 = Buffer.from(raw, "utf8").toString("base64");
  assert.strictEqual(rawBody({ body: b64, isBase64Encoded: true }), raw);
});

check("getStripe returns null when STRIPE_SECRET_KEY unset", () => {
  const prev = process.env.STRIPE_SECRET_KEY;
  delete process.env.STRIPE_SECRET_KEY;
  assert.strictEqual(getStripe(), null);
  if (prev !== undefined) process.env.STRIPE_SECRET_KEY = prev;
});

check("constructWebhookEvent fails closed without webhook secret", () => {
  const prevS = process.env.STRIPE_SECRET_KEY;
  const prevW = process.env.STRIPE_WEBHOOK_SECRET;
  process.env.STRIPE_SECRET_KEY = "sk_test_dummy_not_real";
  delete process.env.STRIPE_WEBHOOK_SECRET;
  let threw = false;
  try {
    constructWebhookEvent({
      body: "{}",
      headers: { "stripe-signature": "t=1,v1=abc" },
    });
  } catch (e) {
    threw = true;
    assert.strictEqual(e.status, 500);
  }
  assert.ok(threw);
  if (prevS !== undefined) process.env.STRIPE_SECRET_KEY = prevS;
  else delete process.env.STRIPE_SECRET_KEY;
  if (prevW !== undefined) process.env.STRIPE_WEBHOOK_SECRET = prevW;
});

check("constructWebhookEvent fails without signature header", () => {
  const prevS = process.env.STRIPE_SECRET_KEY;
  const prevW = process.env.STRIPE_WEBHOOK_SECRET;
  process.env.STRIPE_SECRET_KEY = "sk_test_dummy_not_real";
  process.env.STRIPE_WEBHOOK_SECRET = "whsec_dummy_not_real";
  let threw = false;
  try {
    constructWebhookEvent({ body: "{}", headers: {} });
  } catch (e) {
    threw = true;
    assert.strictEqual(e.status, 400);
    assert.match(e.message, /Missing Stripe-Signature/);
  }
  assert.ok(threw);
  if (prevS !== undefined) process.env.STRIPE_SECRET_KEY = prevS;
  else delete process.env.STRIPE_SECRET_KEY;
  if (prevW !== undefined) process.env.STRIPE_WEBHOOK_SECRET = prevW;
  else delete process.env.STRIPE_WEBHOOK_SECRET;
});

// Auth helpers
const auth = require(path.join(__dirname, "..", "netlify/functions/_auth.js"));

check("requireAdminOrCustomer 401 without token", () => {
  const prev = process.env.JWT_SECRET;
  process.env.JWT_SECRET = "test-secret-for-unit-tests-only";
  let threw = false;
  try {
    auth.requireAdminOrCustomer({ headers: {} });
  } catch (e) {
    threw = true;
    assert.strictEqual(e.status, 401);
  }
  assert.ok(threw);
  if (prev !== undefined) process.env.JWT_SECRET = prev;
  else delete process.env.JWT_SECRET;
});

check("issueTrackingToken + customer can access scoped claims", () => {
  const prev = process.env.JWT_SECRET;
  process.env.JWT_SECRET = "test-secret-for-unit-tests-only";
  const token = auth.issueTrackingToken({ id: "ord-1", order_number: "CDD-1" });
  assert.ok(token);
  const decoded = auth.requireAdminOrCustomer({
    headers: { authorization: "Bearer " + token },
  });
  assert.strictEqual(decoded.kind, "customer");
  assert.strictEqual(decoded.decoded.order_id, "ord-1");
  if (prev !== undefined) process.env.JWT_SECRET = prev;
  else delete process.env.JWT_SECRET;
});

check("admin JWT accepted by requireAdmin", () => {
  const jwt = require("jsonwebtoken");
  const prev = process.env.JWT_SECRET;
  process.env.JWT_SECRET = "test-secret-for-unit-tests-only";
  const token = jwt.sign({ role: "admin", user: "t" }, process.env.JWT_SECRET, {
    expiresIn: "1h",
  });
  const decoded = auth.requireAdmin({
    headers: { Authorization: "Bearer " + token },
  });
  assert.strictEqual(decoded.role, "admin");
  if (prev !== undefined) process.env.JWT_SECRET = prev;
  else delete process.env.JWT_SECRET;
});

check("_cors fallback is live site URL", () => {
  const { allowedOrigin } = require(path.join(__dirname, "..", "netlify/functions/_cors.js"));
  const prev = process.env.SITE_ORIGIN;
  delete process.env.SITE_ORIGIN;
  assert.strictEqual(
    allowedOrigin({ headers: {} }),
    "https://coyote-dune-delivery.netlify.app"
  );
  if (prev !== undefined) process.env.SITE_ORIGIN = prev;
});

async function checkAsync(name, fn) {
  try {
    await fn();
    console.log("ok -", name);
  } catch (e) {
    failed++;
    console.error("FAIL -", name, e.message);
  }
}

(async () => {
  const pub = require(path.join(__dirname, "..", "netlify/functions/public-config.js"));

  await checkAsync("public-config rejects POST", async () => {
    const res = await pub.handler({ httpMethod: "POST", headers: {} });
    assert.strictEqual(res.statusCode, 405);
  });

  await checkAsync("public-config GET returns stripePublishableKey field (empty ok)", async () => {
    const prev = process.env.STRIPE_PUBLISHABLE_KEY;
    delete process.env.STRIPE_PUBLISHABLE_KEY;
    const res = await pub.handler({ httpMethod: "GET", headers: {} });
    assert.strictEqual(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.strictEqual(body.stripePublishableKey, "");
    assert.strictEqual(body.stripeConfigured, false);
    assert.match(body.webhookUrl, /coyote-dune-delivery\.netlify\.app\/api\/payment-webhook/);
    if (prev !== undefined) process.env.STRIPE_PUBLISHABLE_KEY = prev;
  });

  if (failed) {
    console.error(failed + " test(s) failed");
    process.exit(1);
  }
  console.log("All payment/auth hardening tests passed.");
})();
