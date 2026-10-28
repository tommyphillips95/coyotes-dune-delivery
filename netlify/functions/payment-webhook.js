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
 * order is already paid or refunded.
 */
async function staleForOrder(supabase, orderId, intentId, opts) {
  const { data: order, error } = await supabase
    .from("orders")
    .select("id, stripe_payment_intent_id, payment_status")
    .eq("id", orderId)
    .maybeSingle();
  if (error) throw error;
  if (!order) return false;
  // Paid or refunded: money already moved; a failed/canceled/requires_action
  // event must never flip it (a refunded order must not show as 'failed').
  if (order.payment_status === "paid" || order.payment_status === "refunded") return true;
  // Already failed for this same intent: a redelivered failed/canceled adds nothing.
  if (opts && opts.failed && order.payment_status === "failed" &&
      (!order.stripe_payment_intent_id || order.stripe_payment_intent_id === intentId)) return true;
  return !!(order.stripe_payment_intent_id && order.stripe_payment_intent_id !== intentId);
}

const IGNORED_STALE = (headers, eventType) => ({
  statusCode: 200,
  headers,
  body: JSON.stringify({ received: true, ignored: "superseded_or_paid", event: eventType }),
});

/**
 * charge.refunded fires for every refund, partial or full, and Stripe may
 * redeliver or reorder events. Work from the charge's CUMULATIVE
 * amount_refunded (never per-event deltas):
 *   - full (charge.refunded === true or amount_refunded >= amount):
 *     orders.payment_status = 'refunded'
 *   - partial: payment_status unchanged; one 'partial_refund' status-log row
 *     with the running total
 * Each logged state carries a marker [refund:<charge id>:<cumulative cents>];
 * a state already logged, or older than one already logged (out of order),
 * is acknowledged and skipped. No schema change.
 */
const REFUND_MARKER = /\[refund:([^:\]]+):(\d+)\]/;
const dollars = (cents) => "$" + (Number(cents || 0) / 100).toFixed(2);

/** Full refund cancelled the order: end open offers, log it, tell the driver. */
async function closeForRefund(supabase, order, now) {
  await supabase.from("dispatch_offers").update({ status: "expired", responded_at: now }).eq("order_id", order.id).eq("status", "offered");
  await supabase.from("order_status_logs").insert([{
    order_id: order.id, status: "cancelled", changed_by: "stripe_webhook",
    note: `Order cancelled: full refund (was ${order.status})` + (order.driver_id ? "; driver notified" : "") + ".",
  }]);
  if (!order.driver_id) return;
  try {
    const { data: d } = await supabase.from("applications").select("id, phone").eq("id", order.driver_id).maybeSingle();
    if (!d || !d.phone) return;
    // Same channel as dispatch/admin driver texts; a no-op without Twilio env.
    const { sendSMS, logSMS } = require("./dispatch");
    const msg = `Coyote's Dune Delivery: ${order.order_number || "your order"} was refunded and cancelled. Do not complete it.`;
    const sent = await sendSMS(d.phone, msg);
    await logSMS(supabase, { order_id: order.id, phone_number: d.phone, message: msg, status: sent.success ? "sent" : "failed", twilio_sid: sent.messageSid || null, error: sent.error || null });
  } catch (e) {
    console.error("[payment-webhook] refund driver notice failed", e.message || e);
  }
}

/**
 * Which order a refunded charge belongs to: metadata.order_id first, then the
 * charge's PaymentIntent matched against orders.stripe_payment_intent_id
 * (refunds made from the Stripe dashboard on charges without metadata).
 * Returns null when neither finds an order.
 */
async function resolveRefundOrderId(supabase, charge) {
  if (!charge) return null;
  const metaId = charge.metadata && charge.metadata.order_id;
  if (metaId) {
    const { data, error } = await supabase.from("orders").select("id").eq("id", metaId).maybeSingle();
    if (error) throw error;
    if (data) return data.id;
  }
  const pi = typeof charge.payment_intent === "string" ? charge.payment_intent
    : (charge.payment_intent && charge.payment_intent.id) || null;
  if (!pi) return null;
  const { data: rows, error } = await supabase.from("orders").select("id").eq("stripe_payment_intent_id", pi).limit(2);
  if (error) throw error;
  if (!rows || rows.length !== 1) {
    if (rows && rows.length > 1) console.warn("[payment-webhook] refund PaymentIntent matches several orders; not guessing", pi);
    return null;
  }
  return rows[0].id;
}

async function handleRefund(supabase, headers, charge) {
  const ok = (extra) => ({ statusCode: 200, headers, body: JSON.stringify(Object.assign({ received: true }, extra)) });
  const orderId = await resolveRefundOrderId(supabase, charge);
  if (!orderId) {
    console.warn("[payment-webhook] charge.refunded with no matching order", JSON.stringify({
      charge: charge && charge.id, payment_intent: charge && charge.payment_intent,
      metadata_order_id: (charge && charge.metadata && charge.metadata.order_id) || null,
    }));
    return ok({ warning: "No matching order for refunded charge" });
  }

  const amount = Number(charge.amount) || 0;
  const refundedCents = Number(charge.amount_refunded) || 0;
  const full = charge.refunded === true || (amount > 0 && refundedCents >= amount);
  const marker = `[refund:${charge.id}:${refundedCents}]`;

  const { data: logs, error: logsError } = await supabase
    .from("order_status_logs").select("note").eq("order_id", orderId).limit(500);
  if (logsError) throw logsError;
  let seenMax = -1;
  for (const row of logs || []) {
    const m = REFUND_MARKER.exec((row && row.note) || "");
    if (m && m[1] === String(charge.id)) seenMax = Math.max(seenMax, Number(m[2]));
  }
  if (refundedCents <= seenMax) return ok({ status: full ? "refunded" : "partial_refund", duplicate: true });

  if (full) {
    const now = new Date().toISOString();
    const { data: before, error: rErr } = await supabase.from("orders")
      .select("id, order_number, status, driver_id, pickup_city, dropoff_city").eq("id", orderId).maybeSingle();
    if (rErr) throw rErr;
    // A full refund cancels an open order (pending/assigned/in progress).
    // Completed or already-cancelled orders keep their status.
    const cancel = !!before && !["completed", "cancelled"].includes(before.status);
    const patch = { payment_status: "refunded", updated_at: now };
    if (cancel) patch.status = "cancelled";
    const { error } = await supabase.from("orders").update(patch).eq("id", orderId);
    if (error) throw error;
    await supabase.from("order_status_logs").insert([{
      order_id: orderId,
      status: "refunded",
      note: `Refund issued: ${dollars(refundedCents)} of ${dollars(amount)} (full) ${marker}`,
      changed_by: "stripe_webhook",
    }]);
    if (cancel) await closeForRefund(supabase, before, now);
    return ok({ status: "refunded", cancelled: cancel });
  }

  await supabase.from("order_status_logs").insert([{
    order_id: orderId,
    status: "partial_refund",
    note: `Partial refund: ${dollars(refundedCents)} of ${dollars(amount)} refunded so far ${marker}`,
    changed_by: "stripe_webhook",
  }]);
  return ok({ status: "partial_refund", amount_refunded: refundedCents });
}

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
    // Message only: the Stripe error object carries the signature header and the raw body.
    if (err.cause) console.error("[payment-webhook] signature check:", String(err.cause.message || "failed").slice(0, 200));
    return errorResponse(headers, err, "Webhook not accepted", "payment-webhook");
  }

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  const eventType = stripeEvent.type;
  const paymentIntent = (stripeEvent && stripeEvent.data && stripeEvent.data.object) || null;
  if (!eventType || !paymentIntent || typeof paymentIntent !== "object") {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "Malformed event" }) };
  }
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
      const { data: current, error: currentError } = await supabase
        .from("orders").select("stripe_payment_intent_id, payment_status, status").eq("id", orderId).maybeSingle();
      if (currentError) throw currentError;
      const currentId = current && current.stripe_payment_intent_id;
      const otherIntent = currentId && currentId !== paymentIntent.id ? currentId : null;
      // Stripe redelivers events (for days after a failed or slow delivery) and
      // doesn't promise order. A late "succeeded" must not undo a refund:
      // flipping a refunded order back to paid would dispatch a driver for an
      // order whose money was returned.
      if (current && current.payment_status === "refunded") {
        console.error(`[payment-webhook] ${paymentIntent.id} succeeded event for refunded order ${orderId}; left refunded`);
        return { statusCode: 200, headers, body: JSON.stringify({ received: true, ignored: "already_refunded", event: eventType }) };
      }
      // Same intent already recorded as paid: a redelivery. Don't log a second
      // payment; still let dispatch run (it is idempotent) in case it failed before.
      const redelivery = !!(current && current.payment_status === "paid" && currentId === paymentIntent.id);
      // Money arrived for an order that was already cancelled (e.g. a
      // checkout left open while admin cancelled it). Record it as paid, flag
      // it for a refund, and don't dispatch.
      const paidWhileClosed = !!(current && current.status === "cancelled");
      if (paidWhileClosed) console.error(`[payment-webhook] ${paymentIntent.id} succeeded for ${current.status} order ${orderId}; needs a refund`);
      if (otherIntent) console.error(`[payment-webhook] ${paymentIntent.id} succeeded but order ${orderId} points at ${otherIntent}`);
      if (!redelivery) {
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
              : "") +
            (paidWhileClosed
              ? ` (WARNING: paid after the order was ${current.status}; no driver will be sent. Refund ${paymentIntent.id} in Stripe.)`
              : ""),
          changed_by: "stripe_webhook",
        },
      ]);
      }
      let dispatch = null;
      if (paidWhileClosed) {
        dispatch = { offered: false, reason: "order_" + current.status };
      } else try {
        dispatch = await offerNext(supabase, orderId);
      } catch (e) {
        console.error("[payment-webhook] offerNext:", e);
        dispatch = { offered: false, reason: "dispatch_error" };
      }
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify(Object.assign({ received: true, status: "paid", dispatch }, redelivery ? { duplicate: true } : {})),
      };
    }

    if (eventType === "payment_intent.payment_failed" && orderId) {
      if (await staleForOrder(supabase, orderId, paymentIntent.id, { failed: true })) return IGNORED_STALE(headers, eventType);
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
      if (await staleForOrder(supabase, orderId, paymentIntent.id, { failed: true })) return IGNORED_STALE(headers, eventType);
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
      return await handleRefund(supabase, headers, stripeEvent.data.object);
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
