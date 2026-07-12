/**
 * Netlify Function: Stripe Payment Webhook
 * POST /api/payment-webhook
 *
 * Receives Stripe webhook events for payment lifecycle updates.
 * Verifies webhook signature, then updates the order status in Supabase.
 *
 * Stripe webhook events handled:
 *   - payment_intent.succeeded   → mark order as paid
 *   - payment_intent.payment_failed → mark order as failed, log reason
 */

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { createClient } = require('@supabase/supabase-js');

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  // Validate Stripe webhook secret is configured
  if (!process.env.STRIPE_WEBHOOK_SECRET) {
    console.error('STRIPE_WEBHOOK_SECRET is not configured');
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'Stripe webhook secret is not configured.' }),
    };
  }

  const sig = event.headers['stripe-signature'] || event.headers['Stripe-Signature'];
  if (!sig) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: 'Missing Stripe-Signature header' }),
    };
  }

  let stripeEvent;
  try {
    // Verify the webhook signature using the raw body
    stripeEvent = stripe.webhooks.constructEvent(
      event.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: 'Invalid signature', message: err.message }),
    };
  }

  // Initialize Supabase client
  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
  );

  const eventType = stripeEvent.type;
  const paymentIntent = stripeEvent.data.object;
  const orderId = paymentIntent.metadata?.order_id;

  console.log(`Received Stripe webhook: ${eventType} for order ${orderId || 'unknown'}`);

  try {
    // ── payment_intent.succeeded ────────────────────────────
    if (eventType === 'payment_intent.succeeded') {
      if (!orderId) {
        console.warn('PaymentIntent succeeded but no order_id in metadata');
        return { statusCode: 200, headers, body: JSON.stringify({ received: true, warning: 'No order_id in metadata' }) };
      }

      // Update order payment status to paid
      const { error: updateError } = await supabase
        .from('orders')
        .update({
          payment_status: 'paid',
          final_price: paymentIntent.amount_received / 100, // cents to dollars
          updated_at: new Date().toISOString(),
        })
        .eq('id', orderId);

      if (updateError) {
        console.error('Failed to update order on payment success:', updateError);
        return { statusCode: 500, headers, body: JSON.stringify({ error: 'Failed to update order' }) };
      }

      // Log the status change
      await supabase
        .from('order_status_logs')
        .insert([{
          order_id: orderId,
          status: 'paid',
          note: `Payment succeeded via Stripe. Amount: $${(paymentIntent.amount_received / 100).toFixed(2)}`,
          changed_by: 'stripe_webhook',
        }]);

      console.log(`Order ${orderId} marked as paid`);
      return { statusCode: 200, headers, body: JSON.stringify({ received: true, status: 'paid' }) };
    }

    // ── payment_intent.payment_failed ───────────────────────
    if (eventType === 'payment_intent.payment_failed') {
      if (!orderId) {
        console.warn('PaymentIntent failed but no order_id in metadata');
        return { statusCode: 200, headers, body: JSON.stringify({ received: true, warning: 'No order_id in metadata' }) };
      }

      const failureMessage = paymentIntent.last_payment_error?.message || 'Payment failed';
      const failureCode = paymentIntent.last_payment_error?.code || 'unknown';

      // Update order payment status to failed
      const { error: updateError } = await supabase
        .from('orders')
        .update({
          payment_status: 'failed',
          updated_at: new Date().toISOString(),
        })
        .eq('id', orderId);

      if (updateError) {
        console.error('Failed to update order on payment failure:', updateError);
        return { statusCode: 500, headers, body: JSON.stringify({ error: 'Failed to update order' }) };
      }

      // Log the failure
      await supabase
        .from('order_status_logs')
        .insert([{
          order_id: orderId,
          status: 'failed',
          note: `Payment failed: ${failureMessage} (code: ${failureCode})`,
          changed_by: 'stripe_webhook',
        }]);

      console.log(`Order ${orderId} marked as payment failed: ${failureMessage}`);
      return { statusCode: 200, headers, body: JSON.stringify({ received: true, status: 'failed', reason: failureMessage }) };
    }

    // ── payment_intent.requires_action ──────────────────────
    if (eventType === 'payment_intent.requires_action') {
      if (orderId) {
        await supabase
          .from('orders')
          .update({ payment_status: 'pending' })
          .eq('id', orderId);
      }
      return { statusCode: 200, headers, body: JSON.stringify({ received: true, status: 'requires_action' }) };
    }

    // ── payment_intent.canceled ─────────────────────────────
    if (eventType === 'payment_intent.canceled') {
      if (orderId) {
        await supabase
          .from('orders')
          .update({ payment_status: 'failed' })
          .eq('id', orderId);

        await supabase
          .from('order_status_logs')
          .insert([{
            order_id: orderId,
            status: 'failed',
            note: 'PaymentIntent was canceled',
            changed_by: 'stripe_webhook',
          }]);
      }
      return { statusCode: 200, headers, body: JSON.stringify({ received: true, status: 'canceled' }) };
    }

    // ── charge.refunded ───────────────────────────────────────
    if (eventType === 'charge.refunded') {
      const charge = stripeEvent.data.object;
      const refundedOrderId = charge.metadata?.order_id;
      if (refundedOrderId) {
        await supabase
          .from('orders')
          .update({ payment_status: 'refunded' })
          .eq('id', refundedOrderId);

        await supabase
          .from('order_status_logs')
          .insert([{
            order_id: refundedOrderId,
            status: 'refunded',
            note: `Refund issued: $${(charge.amount_refunded / 100).toFixed(2)}`,
            changed_by: 'stripe_webhook',
          }]);
      }
      return { statusCode: 200, headers, body: JSON.stringify({ received: true, status: 'refunded' }) };
    }

    // Unhandled event type — acknowledge receipt
    console.log(`Unhandled event type: ${eventType}`);
    return { statusCode: 200, headers, body: JSON.stringify({ received: true, event: eventType }) };

  } catch (err) {
    console.error('Error processing webhook:', err);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'Webhook processing failed', message: err.message }),
    };
  }
};
