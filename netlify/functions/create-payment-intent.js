/**
 * Netlify Function: Create Stripe Payment Intent
 * POST /api/create-payment-intent
 *
 * Amount is taken from orders.estimated_price (server), never trusted from the client alone.
 */

const { createClient } = require("@supabase/supabase-js");
const { serverError } = require("./_errors");
const { headers: corsHeaders } = require("./_cors");
const { getStripe, resolveChargeAmountCents } = require("./_stripe");

/**
 * Stripe customer for this payment, reused per OUR customer record, never
 * looked up by the typed email.
 *
 * The email on the checkout form is unverified. Picking a Stripe customer by
 * email (in our DB or via Stripe search) would let anyone type someone else's
 * address and attach a payment to that person's Stripe customer. So:
 *   - the customer is the one create-order already attached to this order
 *     (orders.customer_id, the oldest phone match since #51);
 *   - reuse customers.stripe_customer_id when it is set and still exists;
 *   - otherwise create one and save it on that one row (by id, never by email).
 * The PaymentIntent never uses a saved payment method: there is no
 * setup_future_usage, payment_method, off_session or ephemeral key, and the
 * browser confirms with the card it just typed. Reusing a Stripe customer
 * therefore cannot expose or charge anyone's saved cards.
 */
function isMissingStripeCustomer(err) {
  return !!err && (err.code === "resource_missing" || err.statusCode === 404);
}

async function resolveStripeCustomer(stripe, supabase, order, customerEmail) {
  let row = null;
  if (order.customer_id) {
    const { data, error } = await supabase
      .from("customers")
      .select("id, stripe_customer_id")
      .eq("id", order.customer_id)
      .maybeSingle();
    if (error) throw error;
    row = data || null;
  }

  const storedId = row && row.stripe_customer_id;
  if (storedId) {
    try {
      const existing = await stripe.customers.retrieve(storedId);
      if (existing && !existing.deleted) return existing.id;
    } catch (err) {
      if (!isMissingStripeCustomer(err)) throw err;
    }
    console.warn("[create-payment-intent] stored Stripe customer is deleted or missing; creating a new one");
  }

  const params = {
    email: customerEmail,
    metadata: { order_id: order.id, order_number: order.order_number },
  };
  if (row) params.metadata.customer_id = row.id;
  // Two tabs paying at once for the same customer get the same Stripe
  // customer back instead of two. Including the stale id lets a replacement
  // be created after a deletion.
  const options = row ? { idempotencyKey: `cdd-customer-${row.id}-${storedId || "new"}` } : undefined;
  const created = await stripe.customers.create(params, options);

  if (row) {
    const { error: saveError } = await supabase
      .from("customers")
      .update({ stripe_customer_id: created.id, updated_at: new Date().toISOString() })
      .eq("id", row.id);
    if (saveError) console.error("[create-payment-intent] could not save stripe_customer_id:", saveError.message);
  }
  return created.id;
}

exports.handler = async (event) => {
  const headers = corsHeaders(event);

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers, body: "" };
  }

  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers, body: JSON.stringify({ error: "Method not allowed" }) };
  }

  const stripe = getStripe();
  if (!stripe) {
    console.error("STRIPE_SECRET_KEY is not configured");
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({
        error: "Stripe is not configured. Please set STRIPE_SECRET_KEY environment variable.",
      }),
    };
  }

  try {
    const body = JSON.parse(event.body || "{}");

    if (!body.order_id || !body.customer_email) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({
          error: "Missing required fields",
          required: ["order_id", "customer_email"],
        }),
      };
    }

    const orderId = body.order_id;
    const customerEmail = String(body.customer_email).trim();

    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

    const { data: order, error: orderError } = await supabase
      .from("orders")
      .select("id, order_number, status, estimated_price, stripe_payment_intent_id, payment_status, customer_id")
      .eq("id", orderId)
      .single();

    if (orderError || !order) {
      return { statusCode: 404, headers, body: JSON.stringify({ error: "Order not found" }) };
    }

    if (order.payment_status === "paid") {
      return { statusCode: 400, headers, body: JSON.stringify({ error: "Order is already paid" }) };
    }

    let amountCents;
    try {
      amountCents = resolveChargeAmountCents(order, body.amount);
    } catch (e) {
      return {
        statusCode: e.status || 400,
        headers,
        body: JSON.stringify({ error: e.message }),
      };
    }

    if (order.stripe_payment_intent_id) {
      const existingIntent = await stripe.paymentIntents.retrieve(order.stripe_payment_intent_id);
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          success: true,
          client_secret: existingIntent.client_secret,
          payment_intent_id: existingIntent.id,
          order_id: orderId,
          amount: amountCents / 100,
          currency: "usd",
          status: "existing",
        }),
      };
    }

    const customerId = await resolveStripeCustomer(stripe, supabase, order, customerEmail);

    const paymentIntent = await stripe.paymentIntents.create({
      amount: amountCents,
      currency: "usd",
      customer: customerId,
      receipt_email: customerEmail,
      metadata: {
        order_id: orderId,
        order_number: order.order_number,
        customer_email: customerEmail,
      },
      automatic_payment_methods: { enabled: true },
      capture_method: "automatic",
    });

    const { error: updateError } = await supabase
      .from("orders")
      .update({
        stripe_payment_intent_id: paymentIntent.id,
        stripe_customer_id: customerId,
        payment_status: "pending",
        updated_at: new Date().toISOString(),
      })
      .eq("id", orderId);

    if (updateError) {
      console.error("Failed to update order with PaymentIntent:", updateError);
    }

    await supabase.from("order_status_logs").insert([
      {
        order_id: orderId,
        status: "pending",
        note: `PaymentIntent created: ${paymentIntent.id}`,
        changed_by: "system",
      },
    ]);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
        client_secret: paymentIntent.client_secret,
        payment_intent_id: paymentIntent.id,
        order_id: orderId,
        amount: amountCents / 100,
        currency: "usd",
        status: "created",
      }),
    };
  } catch (err) {
    return serverError(headers, err, "Failed to create payment intent", "create-payment-intent");
  }
};

exports._resolveStripeCustomer = resolveStripeCustomer;
