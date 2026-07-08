/**
 * Netlify Function: Update Application (Driver Profile)
 * PUT /api/drivers/:id
 */

const { createClient } = require('@supabase/supabase-js');

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'PUT, OPTIONS',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }

  if (event.httpMethod !== 'PUT') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  try {
    const id = event.path.split('/').pop();
    const body = JSON.parse(event.body || '{}');

    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_KEY
    );

    const updateData = {
      phone: body.phone,
      vehicle_make: body.vehicle_make,
      vehicle_model: body.vehicle_model,
      vehicle_year: body.vehicle_year,
      vehicle_color: body.vehicle_color,
      license_plate: body.vehicle_plate || body.license_plate,
      insurance_provider: body.insurance_provider,
      insurance_policy_number: body.insurance_policy,
      insurance_expiry: body.insurance_expiry,
      bank_name: body.bank_name,
      bank_account_number: body.bank_account,
      bank_routing_number: body.bank_routing,
      updated_at: new Date().toISOString(),
    };

    // Remove undefined values
    Object.keys(updateData).forEach(key => {
      if (updateData[key] === undefined) delete updateData[key];
    });

    const { data, error } = await supabase
      .from('applications')
      .update(updateData)
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;

    return { statusCode: 200, headers, body: JSON.stringify({ success: true, data }) };
  } catch (err) {
    console.error('Error updating application:', err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
