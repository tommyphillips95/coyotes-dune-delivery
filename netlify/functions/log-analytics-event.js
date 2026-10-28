/**
 * Netlify Function: Log Analytics Event (Server-Side)
 * POST /api/log-analytics-event
 *
 * Receives analytics events from the frontend and stores them
 * in the analytics_events table for server-side tracking and
 * dashboard reporting.
 *
 * Body: {
 *   event_name: string,
 *   category: string,
 *   user_id: string (optional),
 *   metadata: object (optional)
 * }
 */

const { createClient } = require('@supabase/supabase-js');
const { serverError } = require('./_errors');
const { headers: corsHeaders } = require('./_cors');
const rateLimit = require('./_rate-limit');

const MAX_BODY_CHARS = 8 * 1024;
const MAX_METADATA_CHARS = 4 * 1024;

exports.handler = async (event) => {
  const headers = corsHeaders(event, {
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  });

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  try {
    // Public, unauthenticated write: cap what can be stored per row.
    const bad = (error) => ({ statusCode: 400, headers, body: JSON.stringify({ error }) });
    if (typeof event.body === 'string' && event.body.length > MAX_BODY_CHARS) return bad('Event too large');
    let body;
    try { body = JSON.parse(event.body || '{}'); } catch (_) { return bad('Invalid JSON'); }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return bad('Invalid event');
    const shortText = (v, n) => v === undefined || v === null || (typeof v === 'string' && v.length <= n);
    if (!shortText(body.category, 50) || !shortText(body.user_id, 100)) return bad('Invalid category or user_id');
    if (body.metadata !== undefined && body.metadata !== null &&
        (typeof body.metadata !== 'object' || Array.isArray(body.metadata) || JSON.stringify(body.metadata).length > MAX_METADATA_CHARS)) {
      return bad('Invalid metadata');
    }

    // Validation
    if (!body.event_name || typeof body.event_name !== 'string' || body.event_name.length > 100) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'event_name is required' }),
      };
    }

    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_KEY
    );

    const rl = await rateLimit.hit(supabase, event, 'log-analytics-event');
    if (rl.limited) return rateLimit.tooMany(headers, rl.retryAfterSec);

    const insertData = {
      event_name: body.event_name,
      category: body.category || 'general',
      user_id: body.user_id || null,
      metadata: body.metadata || {},
    };

    const { data, error } = await supabase
      .from('analytics_events')
      .insert([insertData])
      .select()
      .single();

    if (error) throw error;

    return {
      statusCode: 201,
      headers,
      body: JSON.stringify({ success: true, id: data.id }),
    };
  } catch (err) {
    return serverError(headers, err, 'Failed to log event', 'log-analytics-event');
  }
};
