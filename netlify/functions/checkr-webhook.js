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
const { serverError } = require('./_errors');
const { headers: corsHeaders } = require('./_cors');
const crypto = require('crypto');

/* ─── Config ─── */
const CHECKR_WEBHOOK_SECRET = process.env.CHECKR_WEBHOOK_SECRET;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

/* ─── Checkr signature verification ─── */
function verifyCheckrSignature(body, signature) {
  // Fail closed: without the secret anyone could post a "clear" report and
  // auto-approve a driver (deriveApplicationStatus).
  if (!CHECKR_WEBHOOK_SECRET) {
    console.error('CHECKR_WEBHOOK_SECRET not set; rejecting Checkr webhook');
    return false;
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

function header(event, name) {
  const h = (event && event.headers) || {};
  for (const k of Object.keys(h)) if (k.toLowerCase() === name) return h[k];
  return undefined;
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
  const headers = corsHeaders(event, {
    'Access-Control-Allow-Headers': 'Content-Type, X-Checkr-Signature, X-Checkr-Webhook-Signature',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  });

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

  const rawBody = event.isBase64Encoded
    ? Buffer.from(String(event.body || ''), 'base64').toString('utf8')
    : typeof event.body === 'string' ? event.body : '';
  const signature = header(event, 'x-checkr-signature') || header(event, 'x-checkr-webhook-signature');

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
    console.error('Failed to parse Checkr webhook payload');
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: 'Invalid JSON payload' }),
    };
  }

  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON payload' }) };
  }
  const eventType = String(payload.type || payload.event || '');
  const eventId = payload.id ? String(payload.id) : null;

  console.log(`Received Checkr event: ${eventType.slice(0, 60)} (id: ${String(eventId || 'none').slice(0, 60)})`);

  /* Only process events we care about */
  const supportedEvents = ['report.completed', 'report.updated', 'invitation.completed'];
  if (!supportedEvents.includes(eventType)) {
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ received: true, processed: false, reason: 'Event type not handled' }),
    };
  }

  const data = payload.data && typeof payload.data === 'object' ? payload.data : {};
  const report = data.object && typeof data.object === 'object' ? data.object : data;
  const reportId = typeof report.id === 'string' || typeof report.id === 'number' ? String(report.id) : null;
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

    /* ── 1b. Duplicate / replayed / out-of-order events: acknowledge, change nothing ──
     * Checkr signatures carry no timestamp, so a captured event can be resent at
     * any time. Every processed event is in background_check_logs.response_payload. */
    const { data: seen, error: seenError } = await supabase
      .from('background_check_logs')
      .select('response_payload')
      .eq('report_id', reportId);
    if (seenError) throw seenError;
    const prior = (seen || []).map((r) => r && r.response_payload).filter((p) => p && typeof p === 'object');
    const ok200 = (reason) => ({ statusCode: 200, headers, body: JSON.stringify({ received: true, processed: false, reason }) });
    if (eventId && prior.some((p) => String(p.id) === eventId)) return ok200('Duplicate event');
    const ts = (p) => { const t = Date.parse(p && p.created_at); return Number.isFinite(t) ? t : null; };
    const mine = ts(payload);
    if (mine != null && prior.some((p) => ts(p) != null && ts(p) > mine)) return ok200('Older than an event already processed');

    /* ── 2. Map status and build update object ── */
    const newBgStatus = mapCheckrStatus(reportStatus);
    const updatePayload = {
      background_check_status: newBgStatus,
      updated_at: new Date().toISOString(),
    };

    if (eventType === 'report.completed' || reportStatus === 'clear') {
      updatePayload.background_check_completed_at = new Date().toISOString();
    }

    // A rejected application stays rejected: only an admin reopens it.
    const newAppStatus = app.status === 'rejected' ? null : deriveApplicationStatus(newBgStatus);
    if (newAppStatus) {
      updatePayload.status = newAppStatus;
    }

    /* ── 3. Update the application ── */
    const { error: updateError } = await supabase
      .from('applications')
      .update(updatePayload)
      .eq('id', app.id);

    if (updateError) {
      console.error('Supabase update error:', updateError.code || updateError.message || 'error');
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
      console.error('Background-check log insert error:', logError.code || logError.message || 'error');
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
    return serverError(headers, err, 'Internal server error', 'checkr-webhook');
  }
};
