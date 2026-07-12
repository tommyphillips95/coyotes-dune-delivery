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

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  try {
    const body = JSON.parse(event.body || '{}');

    // Validation
    if (!body.event_name || typeof body.event_name !== 'string') {
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
    console.error('Error logging analytics event:', err);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'Failed to log event', message: err.message }),
    };
  }
};
