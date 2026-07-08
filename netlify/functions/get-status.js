/**
 * Netlify Function: Get Application Status (Driver Portal)
 * POST /api/drivers/status
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
    const { applicantId, email } = body;

    if (!applicantId || !email) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'applicantId and email required' }) };
    }

    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_KEY
    );

    const { data, error } = await supabase
      .from('applications')
      .select('*, documents(*)')
      .eq('id', applicantId)
      .eq('email', email.toLowerCase())
      .single();

    if (error || !data) {
      return { statusCode: 404, headers, body: JSON.stringify({ error: 'Application not found' }) };
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        ...data,
        name: `${data.first_name} ${data.last_name}`,
        dob: data.date_of_birth,
        vehicle_plate: data.license_plate,
        insurance_policy: data.insurance_policy_number,
        bank_account: data.bank_account_number,
        bank_routing: data.bank_routing_number,
      }),
    };
  } catch (err) {
    console.error('Error fetching status:', err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
