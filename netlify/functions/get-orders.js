/**
 * Netlify Function: Get Orders
 * GET /api/orders?phone=XXX&order_number=YYY
 * GET /api/orders/:id
 */

const { createClient } = require('@supabase/supabase-js');

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }

  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  try {
    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_KEY
    );

    // Parse query params
    const url = new URL(event.rawUrl || `http://localhost${event.path}`);
    const phone = url.searchParams.get('phone');
    const orderNumber = url.searchParams.get('order_number');
    const orderId = url.searchParams.get('id');

    let query = supabase
      .from('orders')
      .select(`
        *,
        customer:customers(first_name, last_name, phone, email),
        order_items(*),
        status_logs:order_status_logs(*)
      `);

    if (orderId) {
      query = query.eq('id', orderId).single();
    } else if (orderNumber) {
      query = query.eq('order_number', orderNumber.toUpperCase());
      if (phone) {
        // Verify phone matches customer
        query = query.eq('customer.phone', phone);
      }
    } else if (phone) {
      // Get all orders for this phone number
      query = query.eq('customer.phone', phone).order('created_at', { ascending: false });
    } else {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'Please provide phone, order_number, or id parameter' }),
      };
    }

    const { data, error } = await query;

    if (error) throw error;

    if (!data || (Array.isArray(data) && data.length === 0)) {
      return {
        statusCode: 404,
        headers,
        body: JSON.stringify({ error: 'Order not found' }),
      };
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ success: true, data }),
    };
  } catch (err) {
    console.error('Error fetching orders:', err);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'Failed to fetch orders', message: err.message }),
    };
  }
};
