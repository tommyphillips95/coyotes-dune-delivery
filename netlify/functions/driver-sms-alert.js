/**
 * Netlify Function: Driver SMS Alert
 * POST /api/driver-sms-alert
 *
 * Sends SMS to all approved drivers about a new order.
 * Can be called from admin dashboard or automatically when a new order comes in.
 */

const { createClient } = require('@supabase/supabase-js');

// Lazy-load Twilio SDK
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

  // Validate Twilio credentials
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
    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_KEY
    );

    // ── Fetch approved drivers with phone numbers ───────────
    const { data: drivers, error: driverError } = await supabase
      .from('applications')
      .select('id, first_name, last_name, phone')
      .eq('status', 'approved')
      .not('phone', 'is', null);

    if (driverError) throw driverError;

    if (!drivers || drivers.length === 0) {
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          success: true,
          message: 'No approved drivers found with phone numbers.',
          sentCount: 0,
          failedCount: 0,
        }),
      };
    }

    // ── Build message ───────────────────────────────────────
    const driverPortalUrl = body.driver_portal_url || 'https://coyotes-dune-delivery.netlify.app/driver/';
    const messageBody = body.message || `New order available! Log in to accept: ${driverPortalUrl}`;

    // ── Send SMS to each driver ─────────────────────────────
    const twilio = getTwilioClient();
    const results = [];
    let sentCount = 0;
    let failedCount = 0;

    for (const driver of drivers) {
      // Skip drivers without phone numbers
      if (!driver.phone || driver.phone.trim().length < 10) {
        results.push({
          driverId: driver.id,
          name: `${driver.first_name} ${driver.last_name}`,
          status: 'skipped',
          reason: 'No valid phone number',
        });
        continue;
      }

      let messageSid = null;
      let status = 'sent';
      let error = null;

      try {
        const message = await twilio.messages.create({
          body: messageBody,
          from: process.env.TWILIO_PHONE_NUMBER,
          to: driver.phone.trim(),
        });
        messageSid = message.sid;
        sentCount++;
        console.log(`Driver alert sent to ${driver.phone}: ${messageSid}`);
      } catch (twilioErr) {
        status = 'failed';
        error = twilioErr.message || 'Unknown Twilio error';
        failedCount++;
        console.error(`Failed to send SMS to driver ${driver.id}:`, twilioErr);
      }

      // Log each SMS attempt
      await supabase
        .from('sms_logs')
        .insert([{
          order_id: body.order_id || null,
          phone_number: driver.phone.trim(),
          message: messageBody,
          status: status,
          twilio_sid: messageSid,
          error: error,
        }]);

      results.push({
        driverId: driver.id,
        name: `${driver.first_name} ${driver.last_name}`,
        phone: driver.phone,
        status: status,
        messageSid: messageSid,
        error: error,
      });
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
        sentCount: sentCount,
        failedCount: failedCount,
        totalDrivers: drivers.length,
        results: results,
      }),
    };
  } catch (err) {
    console.error('Error in driver-sms-alert function:', err);
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
