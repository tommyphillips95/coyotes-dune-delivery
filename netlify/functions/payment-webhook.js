/**
 * POST /api/payment-webhook
 * After payment_intent.succeeded, offer the order to the nearest online 4x4/UTV/AWD.
 */

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { createClient } = require('@supabase/supabase-js');
const { offerNext } = require('./dispatch');

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  if (!process.env.STRIPE_WEBHOOK_SECRET) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Stripe webhook secret is not configured.' }) };
  }

  const sig = event.headers['stripe-signature'] || event.headers['Stripe-Signature'];
  if (!sig) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing Stripe-Signature header' }) };
  }

  let stripeEvent;
  try {
    stripeEvent = stripe.webhooks.constructEvent(event.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid signature', message: err.message }) };
  }

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  const eventType = stripeEvent.type;
  const paymentIntent = stripeEvent.data.object;
  const orderId = paymentIntent.metadata && paymentIntent.metadata.order_id;

  try {
    if (eventType === 'payment_intent.succeeded') {
      if (!orderId) {
        return { statusCode: 200, headers, body: JSON.stringify({ received: true, warning: 'No order_id in metadata' }) };
      }
      const { error: updateError } = await supabase.from('orders').update({
        payment_status: 'paid',
        final_price: paymentIntent.amount_received / 100,
        updated_at: new Date().toISOString(),
      }).eq('id', orderId);
      if (updateError) {
        return { statusCode: 500, headers, body: JSON.stringify({ error: 'Failed to update order' }) };
      }
      await supabase.from('order_status_logs').insert([{
        order_id: orderId,
        status: 'paid',
        note: 'Payment succeeded via Stripe. Amount: $' + (paymentIntent.amount_received / 100).toFixed(2),
        changed_by: 'stripe_webhook',
      }]);
      let dispatch = null;
      try { dispatch = await offerNext(supabase, orderId); }
      catch (e) { dispatch = { offered: false, reason: e.message }; }
      return { statusCode: 200, headers, body: JSON.stringify({ received: true, status: 'paid', dispatch }) };
    }

    if (eventType === 'payment_intent.payment_failed' && orderId) {
      const failureMessage = (paymentIntent.last_payment_error && paymentIntent.last_payment_error.message) || 'Payment failed';
      await supabase.from('orders').update({ payment_status: 'failed', updated_at: new Date().toISOString() }).eq('id', orderId);
      await supabase.from('order_status_logs').insert([{ order_id: orderId, status: 'failed', note: 'Payment failed: ' + failureMessage, changed_by: 'stripe_webhook' }]);
      return { statusCode: 200, headers, body: JSON.stringify({ received: true, status: 'failed', reason: failureMessage }) };
    }

    if (eventType === 'payment_intent.requires_action' && orderId) {
      await supabase.from('orders').update({ payment_status: 'pending' }).eq('id', orderId);
      return { statusCode: 200, headers, body: JSON.stringify({ received: true, status: 'requires_action' }) };
    }

    if (eventType === 'payment_intent.canceled' && orderId) {
      await supabase.from('orders').update({ payment_status: 'failed' }).eq('id', orderId);
      await supabase.from('order_status_logs').insert([{ order_id: orderId, status: 'failed', note: 'PaymentIntent was canceled', changed_by: 'stripe_webhook' }]);
      return { statusCode: 200, headers, body: JSON.stringify({ received: true, status: 'canceled' }) };
    }

    if (eventType === 'charge.refunded') {
      const charge = stripeEvent.data.object;
      const refundedOrderId = charge.metadata && charge.metadata.order_id;
      if (refundedOrderId) {
        await supabase.from('orders').update({ payment_status: 'refunded' }).eq('id', refundedOrderId);
        await supabase.from('order_status_logs').insert([{ order_id: refundedOrderId, status: 'refunded', note: 'Refund issued', changed_by: 'stripe_webhook' }]);
      }
      return { statusCode: 200, headers, body: JSON.stringify({ received: true, status: 'refunded' }) };
    }

    return { statusCode: 200, headers, body: JSON.stringify({ received: true, event: eventType }) };
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Webhook processing failed', message: err.message }) };
  }
};
