/**
 * Netlify Function: Checkr Webhook Handler
 * POST /api/checkr-webhook
 *
 * Receives background-check event notifications from Checkr.
 * Events handled:
 *   - report.completed
 *   - report.updated
 *   - invitation.completed
 *
 * On each valid event the function:
 *   1. Verifies the Checkr webhook signature (HMAC-SHA256).
 *   2. Looks up the driver application by background_check_report_id.
 *   3. Updates background_check_status, background_check_completed_at,
 *      and optionally the top-level status field.
 *   4. Writes an audit row to background_check_logs.
 */

const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');

/* ─── Config ─── */
const CHECKR_WEBHOOK_SECRET = process.env.CHECKR_WEBHOOK_SECRET;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

/* ─── Checkr signature verification ─── */
function verifyCheckrSignature(body, signature) {
  if (!CHECKR_WEBHOOK_SECRET) {
    console.warn('CHECKR_WEBHOOK_SECRET not set; skipping signature verification');
    return true;
  }
  if (!signature) return false;

  const expected = crypto
    .createHmac('sha256', CHECKR_WEBHOOK_SECRET)
    .update(body, 'utf8')
    .digest('hex');

  try {
    return crypto.timingSafeEqual(
      Buffer.from(expected, 'hex'),
      Buffer.from(signature, 'hex')
    );
  } catch {
    return false;
  }
}

/* ─── Map Checkr report status → application background_check_status ─── */
function mapCheckrStatus(checkrStatus) {
  const status = (checkrStatus || '').toLowerCase();
  const map = {
    clear: 'clear',
    consider: 'consider',
    suspended: 'suspended',
    pending: 'in_progress',
    dispute: 'consider',
  };
  return map[status] || status;
}

/* ─── Decide whether to auto-update top-level application status ─── */
function deriveApplicationStatus(bgStatus) {
  if (bgStatus === 'clear') return 'approved';
  if (bgStatus === 'consider' || bgStatus === 'suspended') return 'on_hold';
  return null; // leave unchanged
}

/* ─── Main handler ─── */
exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, X-Checkr-Signature, X-Checkr-Webhook-Signature',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers,
      body: JSON.stringify({ error: 'Method not allowed' }),
    };
  }

  const rawBody = event.body || '';
  const signature =
    event.headers['x-checkr-signature'] ||
    event.headers['X-Checkr-Signature'] ||
    event.headers['x-checkr-webhook-signature'] ||
    event.headers['X-Checkr-Webhook-Signature'];

  if (!verifyCheckrSignature(rawBody, signature)) {
    console.error('Checkr webhook signature verification failed');
    return {
      statusCode: 401,
      headers,
      body: JSON.stringify({ error: 'Invalid signature' }),
    };
  }

  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch (err) {
    console.error('Failed to parse Checkr webhook payload:', err.message);
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: 'Invalid JSON payload' }),
    };
  }

  const eventType = payload.type || payload.event || '';
  const eventId = payload.id || 'unknown';

  console.log(`Received Checkr event: ${eventType} (id: ${eventId})`);

  /* Only process events we care about */
  const supportedEvents = ['report.completed', 'report.updated', 'invitation.completed'];
  if (!supportedEvents.includes(eventType)) {
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ received: true, processed: false, reason: 'Event type not handled' }),
    };
  }

  const report = payload.data?.object || payload.data || {};
  const reportId = report.id;
  const reportStatus = report.status;

  if (!reportId) {
    console.error('Checkr payload missing report id');
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: 'Missing report id' }),
    };
  }

  try {
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

    /* ── 1. Find the application by background_check_report_id ── */
    const { data: app, error: findError } = await supabase
      .from('applications')
      .select('id, status, background_check_status, background_check_report_id')
      .eq('background_check_report_id', reportId)
      .single();

    if (findError || !app) {
      console.warn(`No application found for Checkr report ${reportId}`);
      /* Return 200 so Checkr doesn't retry; the report may belong to a different system. */
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ received: true, processed: false, reason: 'Application not found' }),
      };
    }

    /* ── 2. Map status and build update object ── */
    const newBgStatus = mapCheckrStatus(reportStatus);
    const updatePayload = {
      background_check_status: newBgStatus,
      updated_at: new Date().toISOString(),
    };

    if (eventType === 'report.completed' || reportStatus === 'clear') {
      updatePayload.background_check_completed_at = new Date().toISOString();
    }

    const newAppStatus = deriveApplicationStatus(newBgStatus);
    if (newAppStatus) {
      updatePayload.status = newAppStatus;
    }

    /* ── 3. Update the application ── */
    const { error: updateError } = await supabase
      .from('applications')
      .update(updatePayload)
      .eq('id', app.id);

    if (updateError) {
      console.error('Supabase update error:', updateError);
      throw updateError;
    }

    /* ── 4. Write audit log ── */
    const logEntry = {
      application_id: app.id,
      provider: 'checkr',
      action: eventType === 'report.completed' ? 'completed' : 'updated',
      status: newBgStatus,
      report_id: reportId,
      response_payload: payload,
    };

    const { error: logError } = await supabase
      .from('background_check_logs')
      .insert([logEntry]);

    if (logError) {
      /* Non-fatal: log the error but don't fail the webhook */
      console.error('Background-check log insert error:', logError);
    }

    console.log(`Application ${app.id} updated → bg_status: ${newBgStatus}, status: ${newAppStatus || app.status}`);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        received: true,
        processed: true,
        applicationId: app.id,
        backgroundCheckStatus: newBgStatus,
        applicationStatus: newAppStatus || app.status,
      }),
    };
  } catch (err) {
    console.error('Error processing Checkr webhook:', err);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'Internal server error', message: err.message }),
    };
  }
};
