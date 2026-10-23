/**
 * Netlify Function: Update Application (Driver Profile)
 * PUT /api/drivers/:id
 */

const { createClient } = require('@supabase/supabase-js');
const { serverError } = require('./_errors');
const { headers: corsHeaders } = require('./_cors');
const { publicProfile, pendingReview } = require('./_driver-profile');

exports.handler = async (event) => {
  const headers = corsHeaders(event, {
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'PUT, OPTIONS',
  });

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }

  if (event.httpMethod !== 'PUT') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  try {
    const id = (event.queryStringParameters || {}).applicantId || event.path.split('/').pop();
    const body = JSON.parse(event.body || '{}');

    // Driver must prove identity the same way the portal login does (applicant ID + email)
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
    if (!id || !email) {
      return { statusCode: 401, headers, body: JSON.stringify({ error: 'applicantId and email required' }) };
    }

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
      // Bank details are owned by Stripe Connect, never written here
      updated_at: new Date().toISOString(),
    };

    // Remove undefined values. The portal never receives the policy number, so
    // a blank policy field means "keep the one on file", not "erase it".
    Object.keys(updateData).forEach(key => {
      if (updateData[key] === undefined) delete updateData[key];
    });
    if (typeof updateData.insurance_policy_number === 'string' && !updateData.insurance_policy_number.trim()) delete updateData.insurance_policy_number;

    // A verified vehicle class belongs to the vehicle an admin checked. If the
    // driver changes make/model/year/plate, the check no longer applies:
    // clear it so beach (4x4) orders wait for a new admin check (_vehicle.js).
    const { data: cur, error: curErr } = await supabase
      .from('applications')
      .select('*')
      .eq('id', id)
      .eq('email', email)
      .maybeSingle();
    if (curErr) throw curErr;
    if (!cur) {
      return { statusCode: 404, headers, body: JSON.stringify({ error: 'Application not found' }) };
    }
    if (cur.status !== 'approved') return pendingReview(headers);
    const VEHICLE_FIELDS = ['vehicle_make', 'vehicle_model', 'vehicle_year', 'license_plate'];
    const norm = (v) => String(v == null ? '' : v).trim().toLowerCase();
    const vehicleChanged = VEHICLE_FIELDS.some((k) => updateData[k] !== undefined && norm(updateData[k]) !== norm(cur[k]));
    if (vehicleChanged && cur.vehicle_class_verified_at) {
      updateData.vehicle_class_verified_at = null;
      updateData.vehicle_class_verified_by = null;
      updateData.notes = (cur.notes ? cur.notes + '\n' : '') + '[' + new Date().toLocaleString('en-US', { timeZone: 'America/Chicago' })
        + ' CT] Driver changed vehicle details; vehicle class verification cleared.';
    }

    const { data, error } = await supabase
      .from('applications')
      .update(updateData)
      .eq('id', id)
      .eq('email', email)
      .select()
      .maybeSingle();

    if (error) throw error;
    if (!data) {
      return { statusCode: 404, headers, body: JSON.stringify({ error: 'Application not found' }) };
    }

    return { statusCode: 200, headers, body: JSON.stringify({ success: true, data: publicProfile(data) }) };
  } catch (err) {
    return serverError(headers, err, 'Failed to update application', 'update-application');
  }
};
