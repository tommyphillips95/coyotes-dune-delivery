/**
 * Netlify Function: Checkr — Create Candidate & Initiate Report
 * POST /api/checkr/create
 */

const { createClient } = require('@supabase/supabase-js');

const CHECKR_API_BASE = 'https://api.checkr.com/v1';

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

  // Verify admin token
  const authHeader = event.headers.authorization || '';
  const token = authHeader.replace('Bearer ', '');
  if (!token) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: 'Unauthorized' }) };
  }

  try {
    const jwt = require('jsonwebtoken');
    const JWT_SECRET = process.env.JWT_SECRET || 'coyote-dune-delivery-secret-key-2024';
    const decoded = jwt.verify(token, JWT_SECRET);
    if (decoded.role !== 'admin') {
      return { statusCode: 403, headers, body: JSON.stringify({ error: 'Admin access required' }) };
    }
  } catch (err) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: 'Invalid token' }) };
  }

  const CHECKR_API_KEY = process.env.CHECKR_API_KEY;
  if (!CHECKR_API_KEY) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Checkr API key not configured' }) };
  }

  const body = JSON.parse(event.body || '{}');
  const { applicationId, package: pkg = 'driver_pro' } = body;

  if (!applicationId) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'applicationId is required' }) };
  }

  try {
    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_KEY
    );

    // Fetch application
    const { data: app, error: appError } = await supabase
      .from('applications')
      .select('*')
      .eq('id', applicationId)
      .single();

    if (appError || !app) {
      return { statusCode: 404, headers, body: JSON.stringify({ error: 'Application not found' }) };
    }

    if (!app.background_check_consent) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Applicant has not consented to background check' }) };
    }

    // Create Checkr candidate
    const candidateRes = await fetch(`${CHECKR_API_BASE}/candidates`, {
      method: 'POST',
      headers: {
        'Authorization': 'Basic ' + Buffer.from(CHECKR_API_KEY + ':').toString('base64'),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        first_name: app.first_name,
        last_name: app.last_name,
        email: app.email,
        phone: app.phone || undefined,
        ssn: app.ssn || undefined,
        dob: app.date_of_birth || undefined,
        zipcode: app.zip_code || undefined,
        driver_license_number: app.driver_license_number || undefined,
        driver_license_state: app.driver_license_state || undefined,
      }),
    });
    const candidate = await candidateRes.json();
    if (!candidateRes.ok) {
      throw new Error(candidate.error?.message || 'Checkr candidate creation failed');
    }

    // Create Checkr report
    const reportRes = await fetch(`${CHECKR_API_BASE}/reports`, {
      method: 'POST',
      headers: {
        'Authorization': 'Basic ' + Buffer.from(CHECKR_API_KEY + ':').toString('base64'),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        candidate_id: candidate.id,
        package: pkg,
      }),
    });
    const report = await reportRes.json();
    if (!reportRes.ok) {
      throw new Error(report.error?.message || 'Checkr report creation failed');
    }

    const now = new Date().toISOString();

    // Update application
    const { error: updateError } = await supabase
      .from('applications')
      .update({
        background_check_status: 'in_progress',
        background_check_report_id: report.id,
        updated_at: now,
        status: app.status === 'pending' ? 'background_check' : app.status,
      })
      .eq('id', applicationId);

    if (updateError) throw updateError;

    // Log action
    await supabase.from('background_check_logs').insert({
      application_id: applicationId,
      provider: 'checkr',
      action: 'initiated',
      status: 'in_progress',
      report_id: report.id,
      response_payload: { candidate, report },
    });

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
        message: 'Background check initiated',
        data: { candidate_id: candidate.id, report_id: report.id, status: report.status },
      }),
    };
  } catch (err) {
    console.error('Error creating Checkr candidate:', err);
    return {
      statusCode: err.status || 500,
      headers,
      body: JSON.stringify({ error: err.message || 'Failed to initiate background check' }),
    };
  }
};
