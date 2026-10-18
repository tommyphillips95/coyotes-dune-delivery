/**
 * POST /api/payment-webhook
 * After payment_intent.succeeded, offer the order to the nearest online 4x4/UTV/AWD.
 * Signature is verified against the raw body (handles Netlify isBase64Encoded).
 */

const { createClient } = require("@supabase/supabase-js");
const { serverError, errorResponse } = require("./_errors");
const { headers: corsHeaders } = require("./_cors");
const { constructWebhookEvent } = require("./_stripe");
const { offerNext } = require("./dispatch");

/**
 * Events are matched to the order by metadata.order_id. create-payment-intent
 * can replace an order's PaymentIntent (cancel old, create new), so a late
 * "canceled"/"failed"/"requires_action" from the OLD intent must not flip the
 * order back after the new one was created or paid.
 * Returns true when this intent is no longer the order's current one, or the
 * order is already paid.
 */
async function staleForOrder(supabase, orderId, intentId) {
  const { data: order, error } = await supabase
    .from("orders")
    .select("id, stripe_payment_intent_id, payment_status")
    .eq("id", orderId)
    .maybeSingle();
  if (error) throw error;
  if (!order) return false;
  if (order.payment_status === "paid") return true;
  return !!(order.stripe_payment_intent_id && order.stripe_payment_intent_id !== intentId);
}

const IGNORED_STALE = (headers, eventType) => ({
  statusCode: 200,
  headers,
  body: JSON.stringify({ received: true, ignored: "superseded_or_paid", event: eventType }),
});

exports.handler = async (event) => {
  // Stripe server-to-server; still avoid wildcard CORS.
  const headers = corsHeaders(event);

  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers, body: "" };
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers, body: JSON.stringify({ error: "Method not allowed" }) };
  }

  let stripeEvent;
  try {
    stripeEvent = constructWebhookEvent(event);
  } catch (err) {
    // Signature/config problems: Stripe sees a short reason; detail is logged.
    if (err.cause) console.error("[payment-webhook] signature check:", err.cause);
    return errorResponse(headers, err, "Webhook not accepted", "payment-webhook");
  }

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  const eventType = stripeEvent.type;
  const paymentIntent = stripeEvent.data.object;
  const orderId = paymentIntent.metadata && paymentIntent.metadata.order_id;

  try {
    if (eventType === "payment_intent.succeeded") {
      if (!orderId) {
        return {
          statusCode: 200,
          headers,
          body: JSON.stringify({ received: true, warning: "No order_id in metadata" }),
        };
      }
      // Money was received, so the order is paid whichever intent it was. If it
      // was not the order's current intent, say so loudly (possible 2nd payment).
      const { data: current } = await supabase
        .from("orders").select("stripe_payment_intent_id").eq("id", orderId).maybeSingle();
      const currentId = current && current.stripe_payment_intent_id;
      const otherIntent = currentId && currentId !== paymentIntent.id ? currentId : null;
      if (otherIntent) console.error(`[payment-webhook] ${paymentIntent.id} succeeded but order ${orderId} points at ${otherIntent}`);
      const { error: updateError } = await supabase
        .from("orders")
        .update({
          payment_status: "paid",
          final_price: paymentIntent.amount_received / 100,
          updated_at: new Date().toISOString(),
        })
        .eq("id", orderId);
      if (updateError) {
        return { statusCode: 500, headers, body: JSON.stringify({ error: "Failed to update order" }) };
      }
      await supabase.from("order_status_logs").insert([
        {
          order_id: orderId,
          status: "paid",
          note:
            "Payment succeeded via Stripe. Amount: $" +
            (paymentIntent.amount_received / 100).toFixed(2) +
            (otherIntent
              ? ` (WARNING: ${paymentIntent.id} is not the order's current PaymentIntent ${otherIntent}; check Stripe for a second payment)`
              : ""),
          changed_by: "stripe_webhook",
        },
      ]);
      let dispatch = null;
      try {
        dispatch = await offerNext(supabase, orderId);
      } catch (e) {
        console.error("[payment-webhook] offerNext:", e);
        dispatch = { offered: false, reason: "dispatch_error" };
      }
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ received: true, status: "paid", dispatch }),
      };
    }

    if (eventType === "payment_intent.payment_failed" && orderId) {
      if (await staleForOrder(supabase, orderId, paymentIntent.id)) return IGNORED_STALE(headers, eventType);
      const failureMessage =
        (paymentIntent.last_payment_error && paymentIntent.last_payment_error.message) ||
        "Payment failed";
      await supabase
        .from("orders")
        .update({ payment_status: "failed", updated_at: new Date().toISOString() })
        .eq("id", orderId);
      await supabase.from("order_status_logs").insert([
        {
          order_id: orderId,
          status: "failed",
          note: "Payment failed: " + failureMessage,
          changed_by: "stripe_webhook",
        },
      ]);
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ received: true, status: "failed", reason: failureMessage }),
      };
    }

    if (eventType === "payment_intent.requires_action" && orderId) {
      if (await staleForOrder(supabase, orderId, paymentIntent.id)) return IGNORED_STALE(headers, eventType);
      await supabase.from("orders").update({ payment_status: "pending" }).eq("id", orderId);
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ received: true, status: "requires_action" }),
      };
    }

    if (eventType === "payment_intent.canceled" && orderId) {
      if (await staleForOrder(supabase, orderId, paymentIntent.id)) return IGNORED_STALE(headers, eventType);
      await supabase.from("orders").update({ payment_status: "failed" }).eq("id", orderId);
      await supabase.from("order_status_logs").insert([
        {
          order_id: orderId,
          status: "failed",
          note: "PaymentIntent was canceled",
          changed_by: "stripe_webhook",
        },
      ]);
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ received: true, status: "canceled" }),
      };
    }

    if (eventType === "charge.refunded") {
      const charge = stripeEvent.data.object;
      const refundedOrderId = charge.metadata && charge.metadata.order_id;
      if (refundedOrderId) {
        await supabase.from("orders").update({ payment_status: "refunded" }).eq("id", refundedOrderId);
        await supabase.from("order_status_logs").insert([
          {
            order_id: refundedOrderId,
            status: "refunded",
            note: "Refund issued",
            changed_by: "stripe_webhook",
          },
        ]);
      }
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ received: true, status: "refunded" }),
      };
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ received: true, event: eventType }),
    };
  } catch (err) {
    return serverError(headers, err, "Webhook processing failed", "payment-webhook");
  }
};
