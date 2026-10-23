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
const { samePhone } = require("./_phone");
const jwt = require("jsonwebtoken");

/**
 * Only the order's owner may start or replace its payment (and get a
 * client_secret). Proof is either:
 *   - the customer tracking token for THIS order (Authorization: Bearer),
 *     which create-order and the track page hand out; or
 *   - the phone number on the order's customer record (body.phone), which the
 *     checkout form always has, for when no token is available.
 * An admin token is also accepted. The typed email is never proof.
 */
function tokenOwnsOrder(event, orderId) {
  const secret = process.env.JWT_SECRET;
  const h = event.headers || {};
  const raw = String(h.authorization || h.Authorization || "").replace(/^Bearer\s+/i, "").trim();
  if (!secret || !raw) return false;
  try {
    const d = jwt.verify(raw, secret);
    return d.role === "admin" || (d.role === "customer" && d.order_id === orderId);
  } catch (e) {
    return false;
  }
}

async function phoneOwnsOrder(supabase, order, phone) {
  if (!phone || !order.customer_id) return false;
  const { data, error } = await supabase.from("customers").select("id, phone").eq("id", order.customer_id).maybeSingle();
  if (error || !data || !data.phone) return false;
  return samePhone(data.phone, phone);
}

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

/**
 * Reuse, update, or replace the order's existing PaymentIntent without ever
 * risking a second charge.
 *   succeeded                     -> no new intent; 409 code "already_paid"
 *   processing / requires_capture -> no new intent; 409 code "payment_processing"
 *   requires_payment_method / requires_confirmation / requires_action
 *       right amount + currency   -> reuse it
 *       wrong amount or currency  -> paymentIntents.update; if that fails,
 *                                    cancel it, then create a fresh one
 *   canceled / missing in Stripe  -> create a fresh one
 *   anything else                 -> error, nothing created
 * Returns { response, statusCode } to answer now, or { replaced } to create.
 */
const CURRENCY = "usd";
const MODIFIABLE = new Set(["requires_payment_method", "requires_confirmation", "requires_action"]);
const IN_FLIGHT = new Set(["processing", "requires_capture"]);

function intentReply(intent, order, amountCents, status) {
  return {
    statusCode: 200,
    response: {
      success: true,
      client_secret: intent.client_secret,
      payment_intent_id: intent.id,
      order_id: order.id,
      amount: amountCents / 100,
      currency: CURRENCY,
      status,
    },
  };
}

async function reconcileExistingIntent(stripe, supabase, order, amountCents) {
  const oldId = order.stripe_payment_intent_id;
  let intent = null;
  try {
    intent = await stripe.paymentIntents.retrieve(oldId);
  } catch (err) {
    if (!(err && (err.code === "resource_missing" || err.statusCode === 404))) throw err;
  }
  if (!intent) return { replaced: oldId };

  if (intent.status === "succeeded") {
    if (order.payment_status !== "paid") {
      // Stripe has the money but our order was never marked paid (webhook
      // missed or delayed). Report it; never charge again.
      console.error(`[create-payment-intent] ${intent.id} succeeded but order ${order.id} is '${order.payment_status}'`);
      await supabase.from("order_status_logs").insert([{
        order_id: order.id,
        status: "paid",
        note: `Stripe reports ${intent.id} succeeded but the order was not marked paid; no new charge was made. Check the payment webhook.`,
        changed_by: "system",
      }]);
    }
    return {
      statusCode: 409,
      response: { error: "This order is already paid.", code: "already_paid", status: "already_paid", order_id: order.id, payment_intent_id: intent.id },
    };
  }

  if (IN_FLIGHT.has(intent.status)) {
    return {
      statusCode: 409,
      response: { error: "A payment for this order is already being processed. Please wait a moment, then check your order status.", code: "payment_processing", status: "in_progress", order_id: order.id, payment_intent_id: intent.id },
    };
  }

  if (MODIFIABLE.has(intent.status)) {
    if (intent.amount === amountCents && intent.currency === CURRENCY) {
      return intentReply(intent, order, amountCents, "existing");
    }
    try {
      const updated = await stripe.paymentIntents.update(intent.id, { amount: amountCents, currency: CURRENCY });
      return intentReply(updated, order, amountCents, "updated");
    } catch (err) {
      console.warn(`[create-payment-intent] could not update ${intent.id}; canceling it before creating a new one`);
      // If this cancel fails (e.g. it just started processing), we stop here
      // rather than risk two payable intents for one order.
      await stripe.paymentIntents.cancel(intent.id);
      return { replaced: intent.id };
    }
  }

  if (intent.status === "canceled") return { replaced: intent.id };

  throw new Error(`Unexpected PaymentIntent status '${intent.status}' for ${intent.id}`);
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

    const owner = tokenOwnsOrder(event, order.id) || (await phoneOwnsOrder(supabase, order, String(body.phone || "").trim()));
    if (!owner) {
      return { statusCode: 403, headers, body: JSON.stringify({ error: "We couldn't confirm this order is yours. Check the phone number on the form, or open the order from its tracking link.", code: "not_order_owner" }) };
    }

    if (order.payment_status === "paid") {
      // Same machine-readable code as a succeeded PaymentIntent, so the
      // checkout shows the "already paid" screen instead of an error.
      return { statusCode: 409, headers, body: JSON.stringify({ error: "This order is already paid.", code: "already_paid", status: "already_paid", order_id: order.id }) };
    }

    // A cancelled order, or one whose payment was refunded, must
    // not take a new card payment: the webhook would mark it paid but dispatch
    // skips closed orders, so the customer would be charged for nothing.
    // Any still-open PaymentIntent is cancelled so an open checkout can't confirm it.
    const closedReason = order.status === "cancelled" ? "cancelled"
      : order.payment_status === "refunded" ? "refunded" : null;
    if (closedReason) {
      if (order.stripe_payment_intent_id) {
        try {
          const open = await stripe.paymentIntents.retrieve(order.stripe_payment_intent_id);
          if (open && MODIFIABLE.has(open.status)) await stripe.paymentIntents.cancel(open.id);
        } catch (e) {
          console.error(`[create-payment-intent] could not cancel open intent for closed order ${order.id}:`, e && e.message);
        }
      }
      const msg = closedReason === "cancelled" ? "This order was cancelled, so it can't be paid."
        : "This order's payment was refunded, so it can't be paid again.";
      return { statusCode: 409, headers, body: JSON.stringify({ error: msg, code: "order_closed", reason: closedReason, order_id: order.id }) };
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

    // An order that already has a PaymentIntent: look before reusing or replacing.
    let replacedIntentId = null;
    if (order.stripe_payment_intent_id) {
      const decision = await reconcileExistingIntent(stripe, supabase, order, amountCents);
      if (decision.response) {
        return { statusCode: decision.statusCode, headers, body: JSON.stringify(decision.response) };
      }
      replacedIntentId = decision.replaced;
    }

    const customerId = await resolveStripeCustomer(stripe, supabase, order, customerEmail);

    const paymentIntent = await stripe.paymentIntents.create({
      amount: amountCents,
      currency: CURRENCY,
      customer: customerId,
      receipt_email: customerEmail,
      metadata: {
        order_id: orderId,
        order_number: order.order_number,
        customer_email: customerEmail,
      },
      automatic_payment_methods: { enabled: true },
      capture_method: "automatic",
    }, {
      // Changes with amount and with the intent being replaced, so a retry of
      // the same attempt dedupes but a replacement never gets the old one back.
      idempotencyKey: `cdd-pi-${orderId}-${amountCents}-${replacedIntentId || "first"}`,
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
        note: replacedIntentId
          ? `PaymentIntent created: ${paymentIntent.id} (replaces ${replacedIntentId})`
          : `PaymentIntent created: ${paymentIntent.id}`,
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
        currency: CURRENCY,
        status: "created",
      }),
    };
  } catch (err) {
    return serverError(headers, err, "Failed to create payment intent", "create-payment-intent");
  }
};

exports._resolveStripeCustomer = resolveStripeCustomer;
