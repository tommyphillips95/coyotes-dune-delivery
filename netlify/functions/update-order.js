/**
 * Netlify Function: Update Order Status
 * PATCH /api/orders/:id
 * Body: { status, note, driver_id }
 */

const { createClient } = require('@supabase/supabase-js');

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'PATCH, OPTIONS',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }

  if (event.httpMethod !== 'PATCH') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  try {
    const body = JSON.parse(event.body || '{}');
    const orderId = body.id || body.order_id;

    if (!orderId) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'Order ID is required' }),
      };
    }

    if (!body.status) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'Status is required' }),
      };
    }

    const validStatuses = ['pending', 'assigned', 'in_progress', 'completed', 'cancelled'];
    if (!validStatuses.includes(body.status)) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: `Invalid status. Must be one of: ${validStatuses.join(', ')}` }),
      };
    }

    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_KEY
    );

    // Build update object
    const updateData = {
      status: body.status,
      updated_at: new Date().toISOString(),
    };

    if (body.driver_id) {
      updateData.driver_id = body.driver_id;
      updateData.assigned_at = new Date().toISOString();
    }

    if (body.final_price !== undefined) {
      updateData.final_price = parseFloat(body.final_price);
    }

    if (body.status === 'completed') {
      updateData.completed_at = new Date().toISOString();
    }

    // Update order
    const { data: order, error: orderError } = await supabase
      .from('orders')
      .update(updateData)
      .eq('id', orderId)
      .select()
      .single();

    if (orderError) throw orderError;

    if (!order) {
      return {
        statusCode: 404,
        headers,
        body: JSON.stringify({ error: 'Order not found' }),
      };
    }

    // Log status change
    await supabase
      .from('order_status_logs')
      .insert([{
        order_id: orderId,
        status: body.status,
        note: body.note || `Status updated to ${body.status}`,
        changed_by: body.changed_by || 'system',
      }]);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ success: true, data: order }),
    };
  } catch (err) {
    console.error('Error updating order:', err);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'Failed to update order', message: err.message }),
    };
  }
};
