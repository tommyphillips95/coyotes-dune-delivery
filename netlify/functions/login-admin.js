/**
 * Netlify Function: Admin Login
 * POST /api/admin/login
 */

const { serverError } = require('./_errors');
const { headers: corsHeaders } = require('./_cors');
const crypto = require('crypto');
const limit = require('./_login-limit');

// Timing-safe: hash both sides to equal length, compare with timingSafeEqual,
// and always check username AND password so the time doesn't reveal which was wrong.
function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a == null ? '' : a)).digest();
  const hb = crypto.createHash('sha256').update(String(b == null ? '' : b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function limiterClient() {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) return null;
  try {
    const { createClient } = require('@supabase/supabase-js');
    return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  } catch (e) {
    return null;
  }
}

function lockedResponse(headers, retryAfterSec) {
  const mins = Math.max(1, Math.ceil(retryAfterSec / 60));
  return {
    statusCode: 429,
    headers: Object.assign({}, headers, { 'Retry-After': String(retryAfterSec) }),
    body: JSON.stringify({ error: `Too many failed sign-in attempts. Try again in ${mins} minute${mins === 1 ? '' : 's'}.`, code: 'login_locked', retry_after: retryAfterSec }),
  };
}

exports.handler = async (event) => {
  // Same origin lock as every other function (SITE_ORIGIN), not '*'.
  const headers = corsHeaders(event, { 'Access-Control-Allow-Methods': 'POST, OPTIONS' });

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  try {
    const body = JSON.parse(event.body || '{}');
    const { username, password } = body;

    const adminUser = process.env.ADMIN_USERNAME;
    const adminPass = process.env.ADMIN_PASSWORD;

    if (!adminUser || !adminPass) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Admin not configured' }) };
    }

    const supabase = limiterClient();
    const lock = await limit.checkLocked(supabase, event, username);
    if (lock.locked) return lockedResponse(headers, lock.retryAfterSec);

    const userOk = safeEqual(username, adminUser);
    const passOk = safeEqual(password, adminPass);
    if (!(userOk && passOk)) {
      await limit.recordFailure(supabase, event, username);
      const after = await limit.checkLocked(supabase, event, username);
      if (after.locked) return lockedResponse(headers, after.retryAfterSec);
      return { statusCode: 401, headers, body: JSON.stringify({ error: 'Invalid credentials' }) };
    }
    await limit.clearFailures(supabase, event, username);

    const jwt = require('jsonwebtoken');
    const token = jwt.sign({ role: 'admin', user: username }, process.env.JWT_SECRET, { expiresIn: '8h' });

    return { statusCode: 200, headers, body: JSON.stringify({ token }) };
  } catch (err) {
    return serverError(headers, err, 'Login failed', 'login-admin');
  }
};
