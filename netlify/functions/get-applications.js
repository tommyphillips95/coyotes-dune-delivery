/**
 * Netlify Function: Get Applications (Admin)
 * GET /api/applications
 */

const { createClient } = require('@supabase/supabase-js');
const { serverError } = require('./_errors');
const { headers: corsHeaders } = require('./_cors');

exports.handler = async (event) => {
  const headers = corsHeaders(event, {
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
  });

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }

  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  // Verify admin token
  const authHeader = event.headers.authorization || '';
  const token = authHeader.replace('Bearer ', '');
  if (!token || !process.env.JWT_SECRET) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: 'Unauthorized' }) };
  }
  try {
    const jwt = require('jsonwebtoken');
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (decoded.role !== 'admin') {
      return { statusCode: 403, headers, body: JSON.stringify({ error: 'Admin access required' }) };
    }
  } catch (err) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: 'Invalid token' }) };
  }

  try {
    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_KEY
    );

    const { data: applications, error } = await supabase
      .from('applications')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) throw error;

    return {
      statusCode: 200,
      headers,
      // DOB and insurance policy number are detail-only: GET /api/admin/applications/:id.
      body: JSON.stringify({ applications: (applications || []).map((a) => {
        const out = Object.assign({}, a);
        delete out.date_of_birth; delete out.insurance_policy_number;
        return out;
      }) }),
    };
  } catch (err) {
    return serverError(headers, err, 'Failed to fetch applications', 'get-applications');
  }
};
