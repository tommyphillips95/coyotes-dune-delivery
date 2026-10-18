/**
 * Netlify Function: Update Order Status (with SMS notifications)
 * PATCH /api/orders/:id
 * Body: { id, status?, note?, driver_id?, confirm? }  (admin JWT)
 * Validation + audit log live in _order-admin.js (shared with the admin router).
 *
 * Sends SMS notifications on key status changes:
 * - assigned: "Your driver [Name] is on the way! Track: [URL]"
 * - completed: "Your delivery is complete. Thanks for choosing Coyote's Dune Delivery!"
 */

const { createClient } = require('@supabase/supabase-js');
const { serverError } = require('./_errors');
const { headers: corsHeaders } = require('./_cors');
const { requireAdmin, jsonError } = require('./_auth');
const { changeOrder, ruleResponse, PAYMENT_FIELDS } = require('./_order-admin');

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
  const headers = corsHeaders(event, {
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'PATCH, OPTIONS',
  });

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }

  if (event.httpMethod !== 'PATCH') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  // Admin JWT only (401 no/invalid token, 403 other roles).
  let admin;
  try {
    admin = requireAdmin(event);
  } catch (err) {
    return jsonError(headers, err);
  }

  try {
    let body;
    try { body = JSON.parse(event.body || '{}'); } catch (e) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) };
    }
    const orderId = body.id || body.order_id;
    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_KEY
    );

    // Same rules as PUT /api/admin/orders/:id: transition map, driver
    // eligibility, no payment fields, audit log with the admin from the JWT
    // (body.changed_by is ignored).
    const change = { status: body.status, driver_id: body.driver_id, note: body.note, confirm: body.confirm };
    PAYMENT_FIELDS.forEach((f) => { if (Object.prototype.hasOwnProperty.call(body, f)) change[f] = body[f]; });
    let result;
    try {
      result = await changeOrder(supabase, orderId, change, admin.user || 'admin');
    } catch (e) {
      const rule = ruleResponse(headers, e);
      if (rule) return rule;
      throw e;
    }
    const order = result.order;
    const isStatusChange = result.from !== result.to;

    // ── Send SMS notifications on status changes ──────────────
    const smsEnabled = !!(
      process.env.TWILIO_ACCOUNT_SID &&
      process.env.TWILIO_AUTH_TOKEN &&
      process.env.TWILIO_PHONE_NUMBER
    );

    if (smsEnabled && isStatusChange && order.customer_id) {
      // Fetch customer phone
      const { data: customer } = await supabase
        .from('customers')
        .select('phone')
        .eq('id', order.customer_id)
        .maybeSingle();

      const customerPhone = customer?.phone || null;

      if (customerPhone && customerPhone.length >= 10) {
        let smsMessage = null;

        if (result.to === 'assigned') {
          // Fetch driver name if driver_id is provided
          let driverName = 'Your driver';
          if (result.driver) {
            driverName = `${result.driver.first_name} ${result.driver.last_name}`;
          }
          const trackUrl = `https://coyotes-dune-delivery.netlify.app/order/?track=${order.order_number}`;
          smsMessage = `Your driver ${driverName} is on the way! Track your order: ${trackUrl} — Coyote's Dune Delivery`;
        }

        if (result.to === 'completed') {
          smsMessage = `Your delivery is complete. Thanks for choosing Coyote's Dune Delivery! — Coyote's Dune Delivery`;
        }

        if (smsMessage) {
          const smsResult = await sendSMS({
            to_phone: customerPhone,
            message_body: smsMessage,
          });

          await logSMS(supabase, {
            order_id: order.id,
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
    return serverError(headers, err, 'Failed to update order', 'update-order');
  }
};
