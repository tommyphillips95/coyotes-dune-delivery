/**
 * Netlify Function: Submit Customer Order
 * POST /api/submit-order
 *
 * Accepts customer ride and delivery orders,
 * validates required fields, and inserts into Supabase.
 */

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

  try {
    const body = JSON.parse(event.body || '{}');

    // ── Validation ──────────────────────────────────────────
    const required = ['customer_name', 'customer_phone', 'order_type', 'pickup_address', 'dropoff_address'];
    const missing = required.filter((key) => !body[key] || String(body[key]).trim() === '');

    if (missing.length > 0) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'Missing required fields', fields: missing }),
      };
    }

    const validTypes = ['ride', 'delivery', 'group_transport'];
    if (!validTypes.includes(body.order_type)) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'Invalid order_type. Must be one of: ride, delivery, group_transport' }),
      };
    }

    // ── Sanitise & build payload ────────────────────────────
    const orderData = {
      customer_name: String(body.customer_name).trim(),
      customer_phone: String(body.customer_phone).replace(/\D/g, '').slice(0, 15),
      customer_email: body.customer_email ? String(body.customer_email).trim().toLowerCase() : null,
      order_type: body.order_type,
      pickup_address: String(body.pickup_address).trim(),
      dropoff_address: String(body.dropoff_address).trim(),
      scheduled_date: body.scheduled_date || null,
      passenger_count: parseInt(body.passenger_count, 10) || 1,
      item_description: body.item_description ? String(body.item_description).trim() : null,
      special_instructions: body.special_instructions ? String(body.special_instructions).trim() : null,
      estimated_price: body.estimated_price ? parseFloat(body.estimated_price) : null,
      status: 'pending',
    };

    // ── Insert into Supabase ────────────────────────────────
    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_KEY
    );

    const { data, error } = await supabase
      .from('orders')
      .insert([orderData])
      .select()
      .single();

    if (error) throw error;

    return {
      statusCode: 201,
      headers,
      body: JSON.stringify({
        success: true,
        orderId: data.id,
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
