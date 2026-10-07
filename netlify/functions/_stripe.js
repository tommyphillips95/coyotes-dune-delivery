/**
 * Shared Stripe helpers for PaymentIntent + webhook paths.
 * Never hardcode secret values — read from env only.
 */

function getStripe() {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return null;
  // Lazy require so unrelated functions are unaffected if stripe is missing at install time.
  const Stripe = require("stripe");
  return new Stripe(key);
}

/** Raw request body for Stripe signature verification (Netlify may base64-encode). */
function rawBody(event) {
  const body = event.body || "";
  if (event.isBase64Encoded) {
    return Buffer.from(body, "base64").toString("utf8");
  }
  return typeof body === "string" ? body : String(body);
}

/**
 * Charge amount in cents from the order row, not the client.
 * If clientAmount (dollars) is provided, it must match within 1 cent.
 */
function resolveChargeAmountCents(order, clientAmount) {
  const server = Number(order && order.estimated_price);
  if (!Number.isFinite(server) || server <= 0) {
    const err = new Error("Order has no valid estimated_price");
    err.status = 400;
    throw err;
  }
  const cents = Math.round(server * 100);
  if (clientAmount !== undefined && clientAmount !== null && clientAmount !== "") {
    const clientNum = parseFloat(clientAmount);
    if (!Number.isFinite(clientNum)) {
      const err = new Error("Invalid client amount");
      err.status = 400;
      throw err;
    }
    const clientCents = Math.round(clientNum * 100);
    if (Math.abs(clientCents - cents) > 1) {
      const err = new Error("Amount does not match order estimated_price");
      err.status = 400;
      throw err;
    }
  }
  return cents;
}

function constructWebhookEvent(event) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) {
    const err = new Error("Stripe webhook secret is not configured.");
    err.status = 500;
    throw err;
  }
  const stripe = getStripe();
  if (!stripe) {
    const err = new Error("Stripe is not configured. Please set STRIPE_SECRET_KEY environment variable.");
    err.status = 500;
    throw err;
  }
  const headers = event.headers || {};
  const sig = headers["stripe-signature"] || headers["Stripe-Signature"];
  if (!sig) {
    const err = new Error("Missing Stripe-Signature header");
    err.status = 400;
    throw err;
  }
  try {
    return stripe.webhooks.constructEvent(rawBody(event), sig, secret);
  } catch (e) {
    const err = new Error("Invalid signature");
    err.status = 400;
    err.cause = e;
    throw err;
  }
}

module.exports = {
  getStripe,
  rawBody,
  resolveChargeAmountCents,
  constructWebhookEvent,
};
