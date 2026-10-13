/**
 * Netlify Function: Create Stripe Payment Intent
 * POST /api/create-payment-intent
 *
 * Amount is taken from orders.estimated_price (server), never trusted from the client alone.
 */

const { createClient } = require("@supabase/supabase-js");
const { headers: corsHeaders } = require("./_cors");
const { getStripe, resolveChargeAmountCents } = require("./_stripe");

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
      .select("id, order_number, status, estimated_price, stripe_payment_intent_id, payment_status")
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

    let customerId;
    const { data: existingCustomer } = await supabase
      .from("customers")
      .select("stripe_customer_id")
      .eq("email", customerEmail)
      .maybeSingle();

    if (existingCustomer && existingCustomer.stripe_customer_id) {
      customerId = existingCustomer.stripe_customer_id;
    } else {
      const customer = await stripe.customers.create({
        email: customerEmail,
        metadata: { order_id: orderId, order_number: order.order_number },
      });
      customerId = customer.id;
      await supabase.from("customers").update({ stripe_customer_id: customerId }).eq("email", customerEmail);
    }

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
    console.error("Error creating PaymentIntent:", err);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: "Failed to create payment intent", message: err.message }),
    };
  }
};
