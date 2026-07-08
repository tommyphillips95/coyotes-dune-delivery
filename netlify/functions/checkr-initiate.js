/**
 * Netlify Function: Initiate Checkr Background Check
 * POST /api/checkr-initiate
 *
 * Triggers a Checkr background check for a driver applicant.
 * Flow:
 *   1. Look up the applicant in Supabase
 *   2. Create a Checkr candidate
 *   3. Create a Checkr background-check report for that candidate
 *   4. Update the application record with report ID + status
 *   5. Write an audit log entry
 *
 * Required env vars:
 *   CHECKR_API_KEY          - Checkr API key (test_ or live_)
 *   CHECKR_PACKAGE          - Checkr package slug (default: driver_pro)
 *   SUPABASE_URL            - Supabase project URL
 *   SUPABASE_SERVICE_KEY    - Supabase service-role key
 */

const { createClient } = require('@supabase/supabase-js');

const CHECKR_BASE_URL = 'https://api.checkr.com/v1';
const DEFAULT_PACKAGE = 'driver_pro';

/**
 * Thin wrapper around Node 20 native fetch for Checkr basic-auth.
 */
async function checkrFetch(path, method, body = null) {
  const apiKey = process.env.CHECKR_API_KEY;
  if (!apiKey) {
    throw new Error('CHECKR_API_KEY environment variable is not set');
  }

  const auth = Buffer.from(`${apiKey}:`).toString('base64');
  const url = `${CHECKR_BASE_URL}${path}`;

  const options = {
    method,
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/json',
    },
  };

  if (body) {
    options.body = JSON.stringify(body);
  }

  const res = await fetch(url, options);
  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    const msg = data.error || data.message || `Checkr HTTP ${res.status}`;
    const err = new Error(msg);
    err.status = res.status;
    err.checkrError = data;
    throw err;
  }

  return data;
}

/**
 * Format a date string (YYYY-MM-DD) into Checkr's MM/DD/YYYY format.
 */
function formatDob(isoDate) {
  if (!isoDate) return undefined;
  const d = new Date(isoDate);
  if (isNaN(d.getTime())) return undefined;
  const month = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  const year = d.getUTCFullYear();
  return `${month}/${day}/${year}`;
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
    return {
      statusCode: 405,
      headers,
      body: JSON.stringify({ error: 'Method not allowed' }),
    };
  }

  try {
    const body = JSON.parse(event.body || '{}');
    const { applicationId } = body;

    if (!applicationId) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'applicationId is required' }),
      };
    }

    // ── 1. Initialise Supabase ───────────────────────────────
    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_KEY
    );

    // ── 2. Fetch applicant ───────────────────────────────────
    const { data: applicant, error: fetchError } = await supabase
      .from('applications')
      .select('*')
      .eq('id', applicationId)
      .single();

    if (fetchError || !applicant) {
      return {
        statusCode: 404,
        headers,
        body: JSON.stringify({
          error: 'Application not found',
          details: fetchError?.message,
        }),
      };
    }

    // ── 3. Guard: consent must be given ──────────────────────
    if (!applicant.background_check_consent) {
      return {
        statusCode: 403,
        headers,
        body: JSON.stringify({
          error: 'Applicant has not consented to a background check',
        }),
      };
    }

    // ── 4. Create Checkr candidate ───────────────────────────
    const candidatePayload = {
      first_name: applicant.first_name,
      last_name: applicant.last_name,
      email: applicant.email,
      phone: applicant.phone || undefined,
      dob: formatDob(applicant.date_of_birth),
      ssn: applicant.ssn || undefined,
    };

    // Remove undefined keys
    Object.keys(candidatePayload).forEach((k) => {
      if (candidatePayload[k] === undefined) delete candidatePayload[k];
    });

    const candidate = await checkrFetch('/candidates', 'POST', candidatePayload);
    const candidateId = candidate.id;

    // ── 5. Create Checkr report ──────────────────────────────
    const packageSlug = process.env.CHECKR_PACKAGE || DEFAULT_PACKAGE;
    const report = await checkrFetch('/reports', 'POST', {
      candidate_id: candidateId,
      package: packageSlug,
    });

    const reportId = report.id;

    // ── 6. Update application record ─────────────────────────
    const { error: updateError } = await supabase
      .from('applications')
      .update({
        background_check_status: 'in_progress',
        background_check_report_id: reportId,
        status: 'background_check',
        updated_at: new Date().toISOString(),
      })
      .eq('id', applicationId);

    if (updateError) {
      // Non-fatal: the Checkr check is already running, just log it
      console.error('Supabase update warning:', updateError.message);
    }

    // ── 7. Write audit log ───────────────────────────────────
    const { error: logError } = await supabase
      .from('background_check_logs')
      .insert([
        {
          application_id: applicationId,
          provider: 'checkr',
          action: 'initiated',
          status: 'in_progress',
          report_id: reportId,
          response_payload: {
            candidate_id: candidateId,
            report_id: reportId,
            package: packageSlug,
          },
        },
      ]);

    if (logError) {
      console.error('Audit log warning:', logError.message);
    }

    // ── 8. Respond ───────────────────────────────────────────
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
        applicationId,
        candidateId,
        reportId,
        status: 'in_progress',
        package: packageSlug,
      }),
    };
  } catch (err) {
    console.error('Checkr initiation error:', err);

    const status = err.status || 500;
    const payload = {
      error: 'Failed to initiate background check',
      message: err.message,
    };

    if (err.checkrError) {
      payload.checkrError = err.checkrError;
    }

    return { statusCode: status, headers, body: JSON.stringify(payload) };
  }
};
