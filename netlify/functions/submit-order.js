/**
 * Netlify Function: Submit Customer Order (with SMS notifications)
 * POST /api/submit-order
 *
 * Accepts customer ride and delivery orders,
 * upserts the customer record, generates an order number,
 * inserts the order into Supabase, and sends confirmation SMS.
 */

const { createClient } = require('@supabase/supabase-js');

function generateOrderNumber() {
  const now = new Date();
  const yyyymmdd = now.toISOString().slice(0, 10).replace(/-/g, '');
  const random = Math.floor(1000 + Math.random() * 9000);
  return 'COY-' + yyyymmdd + '-' + random;
}

function splitName(fullName) {
  const parts = String(fullName).trim().split(/\s+/);
  const firstName = parts[0] || '';
  const lastName = parts.slice(1).join(' ') || '';
  return { firstName, lastName };
}

/**
 * Helper: Send SMS via the send-sms function (internal invoke)
 */
async function sendSMS({ to_phone, message_body, order_id }) {
  try {
    const twilio = require('twilio');
    const client = twilio(
      process.env.TWILIO_ACCOUNT_SID,
      process.env.TWILIO_AUTH_TOKEN
    );

    const message = await client.messages.create({
      body: message_body,
      from: process.env.TWILIO_PHONE_NUMBER,
      to: to_phone,
    });

    return { success: true, messageSid: message.sid };
  } catch (err) {
    console.error('SMS send error:', err);
    return { success: false, error: err.message };
  }
}

/**
 * Helper: Log SMS to Supabase
 */
async function logSMS(supabase, { order_id, phone_number, message, status, twilio_sid, error }) {
  try {
    await supabase.from('sms_logs').insert([{
      order_id,
      phone_number,
      message,
      status,
      twilio_sid,
      error,
    }]);
  } catch (logErr) {
    console.error('Failed to log SMS:', logErr);
  }
}

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

  try {
    const body = JSON.parse(event.body || '{}');

    // ── Validation ──────────────────────────────────────────
    const required = [
      'customer_name',
      'customer_phone',
      'service_type',
      'pickup_address',
      'dropoff_address',
    ];
    const missing = required.filter((key) => !body[key] || String(body[key]).trim() === '');

    if (missing.length > 0) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'Missing required fields', fields: missing }),
      };
    }

    const validTypes = ['ride', 'package_delivery', 'grocery_run', 'group_transport'];
    if (!validTypes.includes(body.service_type)) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({
          error: 'Invalid service_type. Must be one of: ride, package_delivery, grocery_run, group_transport',
        }),
      };
    }

    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_KEY
    );

    // ── Upsert customer by phone ────────────────────────────
    const phone = String(body.customer_phone).replace(/\D/g, '').slice(0, 15);
    const { firstName, lastName } = splitName(body.customer_name);

    let customerId;
    const { data: existingCustomer } = await supabase
      .from('customers')
      .select('id')
      .eq('phone', phone)
      .maybeSingle();

    if (existingCustomer) {
      customerId = existingCustomer.id;
    } else {
      const { data: newCustomer, error: custError } = await supabase
        .from('customers')
        .insert([
          {
            first_name: firstName,
            last_name: lastName,
            phone: phone,
            email: body.customer_email
              ? String(body.customer_email).trim().toLowerCase()
              : null,
          },
        ])
        .select()
        .single();

      if (custError) throw custError;
      customerId = newCustomer.id;
    }

    // ── Build & insert order ────────────────────────────────
    const orderData = {
      order_number: generateOrderNumber(),
      customer_id: customerId,
      service_type: body.service_type,
      pickup_address: String(body.pickup_address).trim(),
      pickup_city: body.pickup_city ? String(body.pickup_city).trim() : '',
      dropoff_address: String(body.dropoff_address).trim(),
      dropoff_city: body.dropoff_city ? String(body.dropoff_city).trim() : '',
      scheduled_date: body.scheduled_date || null,
      scheduled_time: body.scheduled_time || null,
      is_asap: body.is_asap !== false,
      passenger_count: parseInt(body.passenger_count, 10) || 1,
      package_description: body.package_description
        ? String(body.package_description).trim()
        : null,
      package_size: body.package_size || null,
      special_instructions: body.special_instructions
        ? String(body.special_instructions).trim()
        : null,
      estimated_price: body.estimated_price ? parseFloat(body.estimated_price) : null,
      status: 'pending',
    };

    const { data, error } = await supabase
      .from('orders')
      .insert([orderData])
      .select()
      .single();

    if (error) throw error;

    // ── Send confirmation SMS to customer ───────────────────
    const smsEnabled = !!(
      process.env.TWILIO_ACCOUNT_SID &&
      process.env.TWILIO_AUTH_TOKEN &&
      process.env.TWILIO_PHONE_NUMBER
    );

    if (smsEnabled && phone.length >= 10) {
      const smsMessage = `Your order ${data.order_number} has been received. We'll assign a driver shortly. — Coyote's Dune Delivery`;
      const smsResult = await sendSMS({
        to_phone: phone,
        message_body: smsMessage,
        order_id: data.id,
      });

      await logSMS(supabase, {
        order_id: data.id,
        phone_number: phone,
        message: smsMessage,
        status: smsResult.success ? 'sent' : 'failed',
        twilio_sid: smsResult.messageSid || null,
        error: smsResult.error || null,
      });
    }

    return {
      statusCode: 201,
      headers,
      body: JSON.stringify({
        success: true,
        orderId: data.id,
        orderNumber: data.order_number,
        status: data.status,
        message: 'Order received. A driver will be assigned shortly.',
      }),
    };
  } catch (err) {
    console.error('Error submitting order:', err);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({
        error: 'Failed to submit order',
        message: err.message,
      }),
    };
  }
};
