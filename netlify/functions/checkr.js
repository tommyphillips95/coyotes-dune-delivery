/**
 * Unified Checkr Admin API Router
 * Handles all /api/checkr/* endpoints for the admin dashboard
 */

const { createClient } = require('@supabase/supabase-js');
const jwt = require('jsonwebtoken');

const CHECKR_API_BASE = 'https://api.checkr.com/v1';

/* ── helpers ─────────────────────────────── */
function authHeaders(apiKey) {
  return {
    'Authorization': 'Basic ' + Buffer.from(apiKey + ':').toString('base64'),
    'Content-Type': 'application/json',
  };
}

async function verifyAdmin(event) {
  const token = (event.headers.authorization || '').replace('Bearer ', '');
  if (!token) throw Object.assign(new Error('Unauthorized'), { status: 401 });
  const secret = process.env.JWT_SECRET || 'coyote-dune-delivery-secret-key-2024';
  const decoded = jwt.verify(token, secret);
  if (decoded.role !== 'admin') throw Object.assign(new Error('Admin only'), { status: 403 });
  return decoded;
}

function cors() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  };
}

/* ── route handlers ────────────────────────── */

// GET /candidates  → list all applications with background-check info
async function listCandidates(supabase) {
  const { data, error } = await supabase
    .from('applications')
    .select('*, background_check_logs(*)')
    .order('created_at', { ascending: false });

  if (error) throw error;

  const candidates = (data || []).map(app => ({
    id: app.id,
    applicant_id: app.id,
    name: `${app.first_name} ${app.last_name}`,
    email: app.email,
    phone: app.phone,
    dob: app.date_of_birth,
    ssn: app.ssn,
    address: app.address,
    city: app.city,
    state: app.state,
    zip: app.zip_code,
    status: app.status,
    background_check_consent: app.background_check_consent,
    background_check_status: app.background_check_status,
    background_check_report_id: app.background_check_report_id,
    background_check_completed_at: app.background_check_completed_at,
    created_at: app.created_at,
    logs: (app.background_check_logs || []).map(l => ({
      action: l.action,
      status: l.status,
      report_id: l.report_id,
      created_at: l.created_at,
    })),
  }));

  return { data: { candidates } };
}

// GET /candidates/:id  → single application with logs
async function getCandidate(supabase, id) {
  const { data, error } = await supabase
    .from('applications')
    .select('*, background_check_logs(*)')
    .eq('id', id)
    .single();

  if (error || !data) throw Object.assign(new Error('Not found'), { status: 404 });

  const candidate = {
    id: data.id,
    applicant_id: data.id,
    name: `${data.first_name} ${data.last_name}`,
    email: data.email,
    phone: data.phone,
    dob: data.date_of_birth,
    ssn: data.ssn,
    address: data.address,
    city: data.city,
    state: data.state,
    zip: data.zip_code,
    status: data.status,
    background_check_consent: data.background_check_consent,
    background_check_status: data.background_check_status,
    background_check_report_id: data.background_check_report_id,
    background_check_completed_at: data.background_check_completed_at,
    created_at: data.created_at,
    logs: (data.background_check_logs || []).map(l => ({
      action: l.action,
      status: l.status,
      report_id: l.report_id,
      created_at: l.created_at,
    })),
  };

  return { data: candidate };
}

// GET /stats  → background-check stats
async function getStats(supabase) {
  const { data: rows, error } = await supabase
    .from('applications')
    .select('status, background_check_status, background_check_consent');

  if (error) throw error;

  const total = rows.length;
  const consented = rows.filter(r => r.background_check_consent).length;
  const byStatus = {};
  rows.forEach(r => {
    const s = r.background_check_status || 'pending';
    byStatus[s] = (byStatus[s] || 0) + 1;
  });

  return {
    data: {
      total,
      consented,
      byStatus: Object.entries(byStatus).map(([status, count]) => ({ status, count })),
    },
  };
}

// POST /candidates/:id/create  → create Checkr candidate + report
async function createCheck(supabase, id, pkg) {
  const CHECKR_API_KEY = process.env.CHECKR_API_KEY;
  if (!CHECKR_API_KEY) throw Object.assign(new Error('Checkr API key not configured'), { status: 500 });

  const { data: app, error: appError } = await supabase
    .from('applications')
    .select('*')
    .eq('id', id)
    .single();

  if (appError || !app) throw Object.assign(new Error('Application not found'), { status: 404 });
  if (!app.background_check_consent) throw Object.assign(new Error('Applicant has not consented'), { status: 400 });

  // Create Checkr candidate
  const candidateRes = await fetch(`${CHECKR_API_BASE}/candidates`, {
    method: 'POST',
    headers: authHeaders(CHECKR_API_KEY),
    body: JSON.stringify({
      first_name: app.first_name,
      last_name: app.last_name,
      email: app.email,
      phone: app.phone || undefined,
      ssn: app.ssn || undefined,
      dob: app.date_of_birth ? formatDate(app.date_of_birth) : undefined,
      zipcode: app.zip_code || undefined,
      driver_license_number: app.driver_license_number || undefined,
      driver_license_state: app.driver_license_state || undefined,
    }),
  });
  const candidate = await candidateRes.json();
  if (!candidateRes.ok) throw new Error(candidate.error?.message || 'Checkr candidate creation failed');

  // Create Checkr report
  const reportRes = await fetch(`${CHECKR_API_BASE}/reports`, {
    method: 'POST',
    headers: authHeaders(CHECKR_API_KEY),
    body: JSON.stringify({ candidate_id: candidate.id, package: pkg }),
  });
  const report = await reportRes.json();
  if (!reportRes.ok) throw new Error(report.error?.message || 'Checkr report creation failed');

  const now = new Date().toISOString();

  // Update application
  await supabase.from('applications').update({
    background_check_status: 'in_progress',
    background_check_report_id: report.id,
    updated_at: now,
    status: app.status === 'pending' ? 'background_check' : app.status,
  }).eq('id', id);

  // Log
  await supabase.from('background_check_logs').insert({
    application_id: id,
    provider: 'checkr',
    action: 'initiated',
    status: 'in_progress',
    report_id: report.id,
    response_payload: { candidate_id: candidate.id, report_id: report.id },
  });

  return { data: { candidate_id: candidate.id, report_id: report.id, status: report.status } };
}

// POST /candidates/:id/refresh  → poll Checkr for report status
async function refreshCheck(supabase, id) {
  const CHECKR_API_KEY = process.env.CHECKR_API_KEY;
  if (!CHECKR_API_KEY) throw Object.assign(new Error('Checkr API key not configured'), { status: 500 });

  const { data: app, error: appError } = await supabase
    .from('applications')
    .select('*')
    .eq('id', id)
    .single();

  if (appError || !app) throw Object.assign(new Error('Application not found'), { status: 404 });
  if (!app.background_check_report_id) throw Object.assign(new Error('No report ID'), { status: 400 });

  const res = await fetch(`${CHECKR_API_BASE}/reports/${app.background_check_report_id}`, {
    headers: authHeaders(CHECKR_API_KEY),
  });
  const report = await res.json();
  if (!res.ok) throw new Error(report.error?.message || 'Failed to fetch report');

  const checkrStatus = report.status;       // e.g. "pending", "complete"
  const checkrResult = report.result;       // "clear" | "consider" | null
  const now = new Date().toISOString();

  let appStatus = app.status;
  let bgStatus = checkrStatus === 'complete' ? (checkrResult || 'complete') : checkrStatus;

  if (checkrStatus === 'complete') {
    if (checkrResult === 'clear') appStatus = 'approved';
    else if (checkrResult === 'consider') appStatus = 'on_hold';
  }

  await supabase.from('applications').update({
    background_check_status: bgStatus,
    background_check_completed_at: checkrStatus === 'complete' ? now : app.background_check_completed_at,
    updated_at: now,
    status: appStatus,
  }).eq('id', id);

  await supabase.from('background_check_logs').insert({
    application_id: id,
    provider: 'checkr',
    action: 'refreshed',
    status: bgStatus,
    report_id: app.background_check_report_id,
    response_payload: report,
  });

  return { data: { status: bgStatus, result: checkrResult, report } };
}

function formatDate(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return iso;
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const y = d.getFullYear();
  return `${m}/${day}/${y}`;
}

/* ── main handler ──────────────────────────── */
exports.handler = async (event) => {
  const headers = cors();
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }

  try {
    await verifyAdmin(event);

    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_KEY
    );

    // Parse path: event.path includes the part after the function name
    // /api/checkr/candidates → with redirect, function gets /candidates
    const path = event.path || '/';
    const segments = path.split('/').filter(Boolean);
    const method = event.httpMethod;

    // GET /candidates
    if (method === 'GET' && segments.length === 1 && segments[0] === 'candidates') {
      const result = await listCandidates(supabase);
      return { statusCode: 200, headers, body: JSON.stringify(result) };
    }

    // GET /stats
    if (method === 'GET' && segments.length === 1 && segments[0] === 'stats') {
      const result = await getStats(supabase);
      return { statusCode: 200, headers, body: JSON.stringify(result) };
    }

    // GET /candidates/:id
    if (method === 'GET' && segments.length === 2 && segments[0] === 'candidates') {
      const result = await getCandidate(supabase, segments[1]);
      return { statusCode: 200, headers, body: JSON.stringify(result) };
    }

    // POST /candidates/:id/create
    if (method === 'POST' && segments.length === 3 && segments[0] === 'candidates' && segments[2] === 'create') {
      const body = JSON.parse(event.body || '{}');
      const result = await createCheck(supabase, segments[1], body.package || 'driver_pro');
      return { statusCode: 200, headers, body: JSON.stringify(result) };
    }

    // POST /candidates/:id/refresh
    if (method === 'POST' && segments.length === 3 && segments[0] === 'candidates' && segments[2] === 'refresh') {
      const result = await refreshCheck(supabase, segments[1]);
      return { statusCode: 200, headers, body: JSON.stringify(result) };
    }

    return { statusCode: 404, headers, body: JSON.stringify({ error: 'Not found' }) };
  } catch (err) {
    console.error('Checkr router error:', err);
    const status = err.status || 500;
    return { statusCode: status, headers, body: JSON.stringify({ error: err.message }) };
  }
};
