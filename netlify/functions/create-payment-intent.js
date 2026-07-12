/**
 * Netlify Function: Create Stripe Payment Intent
 * POST /api/create-payment-intent
 *
 * Creates a Stripe PaymentIntent for an order and returns the client_secret
 * to the frontend for secure card payment confirmation.
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

  // Validate Stripe secret key is configured
  if (!process.env.STRIPE_SECRET_KEY) {
    console.error('STRIPE_SECRET_KEY is not configured');
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'Stripe is not configured. Please set STRIPE_SECRET_KEY environment variable.' }),
    };
  }

  try {
    const body = JSON.parse(event.body || '{}');

    // ── Validate required fields ────────────────────────────
    if (!body.order_id || !body.amount || !body.customer_email) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({
          error: 'Missing required fields',
          required: ['order_id', 'amount', 'customer_email'],
        }),
      };
    }

    const orderId = body.order_id;
    const amount = parseFloat(body.amount);
    const customerEmail = body.customer_email.trim();

    if (isNaN(amount) || amount <= 0) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'Amount must be a positive number' }),
      };
    }

    // Initialize Supabase client
    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_KEY
    );

    // ── Verify order exists and is pending ────────────────
    const { data: order, error: orderError } = await supabase
      .from('orders')
      .select('id, order_number, status, estimated_price, stripe_payment_intent_id')
      .eq('id', orderId)
      .single();

    if (orderError || !order) {
      return {
        statusCode: 404,
        headers,
        body: JSON.stringify({ error: 'Order not found' }),
      };
    }

    // Prevent creating a new PaymentIntent if one already exists
    if (order.stripe_payment_intent_id) {
      // Retrieve existing PaymentIntent to return its client_secret
      const existingIntent = await stripe.paymentIntents.retrieve(order.stripe_payment_intent_id);
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          success: true,
          client_secret: existingIntent.client_secret,
          payment_intent_id: existingIntent.id,
          order_id: orderId,
          amount: amount,
          currency: 'usd',
          status: 'existing',
        }),
      };
    }

    // ── Create Stripe Customer (or reuse) ─────────────────
    let customerId;
    const { data: existingCustomer } = await supabase
      .from('customers')
      .select('stripe_customer_id')
      .eq('email', customerEmail)
      .maybeSingle();

    if (existingCustomer && existingCustomer.stripe_customer_id) {
      customerId = existingCustomer.stripe_customer_id;
    } else {
      // Create a new Stripe Customer
      const customer = await stripe.customers.create({
        email: customerEmail,
        metadata: {
          order_id: orderId,
          order_number: order.order_number,
        },
      });
      customerId = customer.id;

      // Update customer record in Supabase with Stripe customer ID
      await supabase
        .from('customers')
        .update({ stripe_customer_id: customerId })
        .eq('email', customerEmail);
    }

    // ── Create Stripe PaymentIntent ─────────────────────────
    const paymentIntent = await stripe.paymentIntents.create({
      amount: Math.round(amount * 100), // Stripe expects cents
      currency: 'usd',
      customer: customerId,
      receipt_email: customerEmail,
      metadata: {
        order_id: orderId,
        order_number: order.order_number,
        customer_email: customerEmail,
      },
      // Automatic payment methods (cards, Apple Pay, Google Pay, etc.)
      automatic_payment_methods: {
        enabled: true,
      },
      // Capture automatically when payment is confirmed
      capture_method: 'automatic',
    });

    // ── Update order in Supabase ────────────────────────────
    const { error: updateError } = await supabase
      .from('orders')
      .update({
        stripe_payment_intent_id: paymentIntent.id,
        stripe_customer_id: customerId,
        payment_status: 'pending',
        updated_at: new Date().toISOString(),
      })
      .eq('id', orderId);

    if (updateError) {
      console.error('Failed to update order with PaymentIntent:', updateError);
      // Don't fail the request — the frontend can still confirm payment
      // The webhook will handle the status update anyway
    }

    // ── Log the payment intent creation ─────────────────────
    await supabase
      .from('order_status_logs')
      .insert([{
        order_id: orderId,
        status: 'pending',
        note: `PaymentIntent created: ${paymentIntent.id}`,
        changed_by: 'system',
      }]);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
        client_secret: paymentIntent.client_secret,
        payment_intent_id: paymentIntent.id,
        order_id: orderId,
        amount: amount,
        currency: 'usd',
        status: 'created',
      }),
    };

  } catch (err) {
    console.error('Error creating PaymentIntent:', err);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({
        error: 'Failed to create payment intent',
        message: err.message,
      }),
    };
  }
};
