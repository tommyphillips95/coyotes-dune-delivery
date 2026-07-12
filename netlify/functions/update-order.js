/**
 * Netlify Function: Update Order Status (with SMS notifications)
 * PATCH /api/orders/:id
 * Body: { status, note, driver_id }
 *
 * Sends SMS notifications on key status changes:
 * - assigned: "Your driver [Name] is on the way! Track: [URL]"
 * - completed: "Your delivery is complete. Thanks for choosing Coyote's Dune Delivery!"
 */

const { createClient } = require('@supabase/supabase-js');

/**
 * Helper: Send SMS via Twilio
 */
async function sendSMS({ to_phone, message_body }) {
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

    // ── Fetch current order to check status transition ──────
    const { data: currentOrder, error: fetchError } = await supabase
      .from('orders')
      .select('id, status, customer_id, order_number')
      .eq('id', orderId)
      .single();

    if (fetchError) throw fetchError;

    if (!currentOrder) {
      return {
        statusCode: 404,
        headers,
        body: JSON.stringify({ error: 'Order not found' }),
      };
    }

    // Prevent duplicate notifications for same status
    const isStatusChange = currentOrder.status !== body.status;

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

    // ── Send SMS notifications on status changes ──────────────
    const smsEnabled = !!(
      process.env.TWILIO_ACCOUNT_SID &&
      process.env.TWILIO_AUTH_TOKEN &&
      process.env.TWILIO_PHONE_NUMBER
    );

    if (smsEnabled && isStatusChange) {
      // Fetch customer phone
      const { data: customer } = await supabase
        .from('customers')
        .select('phone')
        .eq('id', order.customer_id)
        .maybeSingle();

      const customerPhone = customer?.phone || null;

      if (customerPhone && customerPhone.length >= 10) {
        let smsMessage = null;

        if (body.status === 'assigned') {
          // Fetch driver name if driver_id is provided
          let driverName = 'Your driver';
          if (body.driver_id) {
            const { data: driver } = await supabase
              .from('applications')
              .select('first_name, last_name')
              .eq('id', body.driver_id)
              .maybeSingle();
            if (driver) {
              driverName = `${driver.first_name} ${driver.last_name}`;
            }
          }
          const trackUrl = `https://coyotes-dune-delivery.netlify.app/order/?track=${order.order_number}`;
          smsMessage = `Your driver ${driverName} is on the way! Track your order: ${trackUrl} — Coyote's Dune Delivery`;
        }

        if (body.status === 'completed') {
          smsMessage = `Your delivery is complete. Thanks for choosing Coyote's Dune Delivery! — Coyote's Dune Delivery`;
        }

        if (smsMessage) {
          const smsResult = await sendSMS({
            to_phone: customerPhone,
            message_body: smsMessage,
          });

          await logSMS(supabase, {
            order_id: orderId,
            phone_number: customerPhone,
            message: smsMessage,
            status: smsResult.success ? 'sent' : 'failed',
            twilio_sid: smsResult.messageSid || null,
            error: smsResult.error || null,
          });
        }
      }
    }

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
