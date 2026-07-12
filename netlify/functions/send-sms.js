/**
 * Netlify Function: Send SMS via Twilio
 * POST /api/send-sms
 *
 * Receives: to_phone, message_body, order_id (optional)
 * Sends SMS via Twilio API, logs to Supabase sms_logs table
 * Returns: message SID or error
 */

const { createClient } = require('@supabase/supabase-js');

// Lazy-load Twilio SDK (only when needed)
let twilioClient = null;
function getTwilioClient() {
  if (!twilioClient) {
    const twilio = require('twilio');
    twilioClient = twilio(
      process.env.TWILIO_ACCOUNT_SID,
      process.env.TWILIO_AUTH_TOKEN
    );
  }
  return twilioClient;
}

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  // Validate Twilio credentials are configured
  if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN || !process.env.TWILIO_PHONE_NUMBER) {
    console.error('Twilio environment variables are not configured');
    return {
      statusCode: 503,
      headers,
      body: JSON.stringify({
        error: 'SMS service not configured',
        message: 'Twilio credentials are missing. Please set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and TWILIO_PHONE_NUMBER environment variables.',
      }),
    };
  }

  try {
    const body = JSON.parse(event.body || '{}');

    // ── Validation ──────────────────────────────────────────
    if (!body.to_phone || typeof body.to_phone !== 'string') {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'to_phone is required' }),
      };
    }

    if (!body.message_body || typeof body.message_body !== 'string') {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'message_body is required' }),
      };
    }

    // Normalize phone number (E.164 format preferred, but let Twilio handle it)
    const toPhone = body.to_phone.trim();
    const messageBody = body.message_body.trim();
    const orderId = body.order_id || null;

    // Enforce message length limit (Twilio max ~1600 chars for single SMS, but keep it reasonable)
    if (messageBody.length > 1600) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'message_body exceeds 1600 character limit' }),
      };
    }

    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_KEY
    );

    // ── Send SMS via Twilio ─────────────────────────────────
    let messageSid = null;
    let twilioStatus = 'sent';
    let twilioError = null;

    try {
      const twilio = getTwilioClient();
      const message = await twilio.messages.create({
        body: messageBody,
        from: process.env.TWILIO_PHONE_NUMBER,
        to: toPhone,
      });
      messageSid = message.sid;
      console.log(`SMS sent successfully: ${messageSid} to ${toPhone}`);
    } catch (twilioErr) {
      twilioStatus = 'failed';
      twilioError = twilioErr.message || 'Unknown Twilio error';
      console.error('Twilio send error:', twilioErr);
    }

    // ── Log to Supabase ─────────────────────────────────────
    const logData = {
      order_id: orderId,
      phone_number: toPhone,
      message: messageBody,
      status: twilioStatus,
      twilio_sid: messageSid,
      error: twilioError,
    };

    const { error: logError } = await supabase
      .from('sms_logs')
      .insert([logData]);

    if (logError) {
      console.error('Failed to log SMS to Supabase:', logError);
      // Don't fail the request if logging fails, but note it
    }

    // ── Response ────────────────────────────────────────────
    if (twilioStatus === 'failed') {
      return {
        statusCode: 502,
        headers,
        body: JSON.stringify({
          success: false,
          error: 'Failed to send SMS',
          message: twilioError,
        }),
      };
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
        messageSid: messageSid,
        status: twilioStatus,
        to: toPhone,
      }),
    };
  } catch (err) {
    console.error('Error in send-sms function:', err);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({
        error: 'Internal server error',
        message: err.message,
      }),
    };
  }
};
