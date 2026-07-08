/**
 * Netlify Function: Checkr — Get Report Status & Refresh
 * GET /api/checkr/refresh?applicationId=...
 */

const { createClient } = require('@supabase/supabase-js');

const CHECKR_API_BASE = 'https://api.checkr.com/v1';

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }

  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

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

  const params = new URLSearchParams(event.rawQuery);
  const applicationId = params.get('applicationId');

  if (!applicationId) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'applicationId is required' }) };
  }

  try {
    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_KEY
    );

    const { data: app, error: appError } = await supabase
      .from('applications')
      .select('*')
      .eq('id', applicationId)
      .single();

    if (appError || !app) {
      return { statusCode: 404, headers, body: JSON.stringify({ error: 'Application not found' }) };
    }

    if (!app.background_check_report_id) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'No background check report found' }) };
    }

    // Fetch report from Checkr
    const reportRes = await fetch(`${CHECKR_API_BASE}/reports/${app.background_check_report_id}`, {
      headers: {
        'Authorization': 'Basic ' + Buffer.from(CHECKR_API_KEY + ':').toString('base64'),
        'Accept': 'application/json',
      },
    });
    const report = await reportRes.json();
    if (!reportRes.ok) {
      throw new Error(report.error?.message || 'Checkr report fetch failed');
    }

    const checkrStatus = report.status;
    const reportResult = report.result;

    let dbStatus = app.background_check_status;
    let completedAt = app.background_check_completed_at;

    if (checkrStatus === 'complete') {
      dbStatus = reportResult || 'clear';
      completedAt = new Date().toISOString();
    } else if (checkrStatus === 'pending') {
      dbStatus = 'in_progress';
    }

    const now = new Date().toISOString();
    let newAppStatus = app.status;

    if (dbStatus === 'clear' && app.status === 'background_check') {
      newAppStatus = 'approved';
    } else if ((dbStatus === 'consider' || dbStatus === 'suspended') && app.status === 'background_check') {
      newAppStatus = 'on_hold';
    }

    const { error: updateError } = await supabase
      .from('applications')
      .update({
        background_check_status: dbStatus,
        background_check_completed_at: completedAt,
        updated_at: now,
        status: newAppStatus,
      })
      .eq('id', applicationId);

    if (updateError) throw updateError;

    await supabase.from('background_check_logs').insert({
      application_id: applicationId,
      provider: 'checkr',
      action: 'completed',
      status: dbStatus,
      report_id: report.id,
      response_payload: report,
    });

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
        data: {
          report_id: report.id,
          checkr_status: checkrStatus,
          result: reportResult,
          background_check_status: dbStatus,
          completed_at: completedAt,
        },
      }),
    };
  } catch (err) {
    console.error('Error refreshing Checkr status:', err);
    return {
      statusCode: err.status || 500,
      headers,
      body: JSON.stringify({ error: err.message || 'Failed to refresh status' }),
    };
  }
};
