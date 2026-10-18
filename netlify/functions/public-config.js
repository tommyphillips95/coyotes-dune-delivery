/**
 * GET /api/public-config
 * Non-secret frontend config (Stripe publishable key, site origin).
 * Never returns secret keys.
 */
const { headers: corsHeaders } = require("./_cors");

exports.handler = async (event) => {
  const headers = {
    ...corsHeaders(event),
    "Cache-Control": "public, max-age=60",
  };

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers, body: "" };
  }
  if (event.httpMethod !== "GET") {
    return { statusCode: 405, headers, body: JSON.stringify({ error: "Method not allowed" }) };
  }

  const stripePublishableKey = process.env.STRIPE_PUBLISHABLE_KEY || "";
  const siteOrigin =
    (process.env.SITE_ORIGIN || "").split(",")[0].trim() ||
    "https://coyote-dune-delivery.netlify.app";

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({
      siteOrigin,
      stripePublishableKey,
      stripeConfigured: Boolean(stripePublishableKey),
      webhookUrl: `${siteOrigin.replace(/\/$/, "")}/api/payment-webhook`,
    }),
  };
};
