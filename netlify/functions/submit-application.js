/**
 * Netlify Function: Submit Driver Application
 * POST /api/submit-application (also /api/applications via redirect)
 *
 * Does not accept or store SSN or bank account fields. Those go through
 * Checkr and Stripe Connect after approval.
 */

const { createClient } = require('@supabase/supabase-js');
const cors = require('./_cors');

exports.handler = async (event) => {
  const headers = cors.headers(event, { 'Content-Type': 'application/json' });

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  try {
    const body = JSON.parse(event.body || '{}');

    // Reject accidental PII in the payload (do not persist).
    const forbidden = ['ssn', 'bank_account_number', 'bank_routing_number', 'accountNumber', 'routingNumber', 'confirmAccountNumber'];
    for (const key of forbidden) {
      if (body[key] != null && String(body[key]).trim() !== '') {
        return {
          statusCode: 400,
          headers,
          body: JSON.stringify({ error: 'Do not send SSN or bank details to this endpoint' }),
        };
      }
    }

    const applicationData = {
      first_name: body.first_name || body.firstName,
      last_name: body.last_name || body.lastName,
      email: body.email,
      phone: body.phone,
      date_of_birth: body.date_of_birth || body.dob,
      address: body.address,
      city: body.city,
      state: body.state,
      zip_code: body.zip || body.zip_code,
      emergency_contact_name: body.emergency_contact_name || body.emergencyName,
      emergency_contact_phone: body.emergency_contact_phone || body.emergencyPhone,
      driver_license_number: body.driver_license_number || body.licenseNumber,
      driver_license_state: body.driver_license_state || body.licenseState,
      driver_license_expiry: body.driver_license_expiry || body.licenseExpiry,
      vehicle_year: body.vehicle_year || body.vehicleYear,
      vehicle_make: body.vehicle_make || body.vehicleMake,
      vehicle_model: body.vehicle_model || body.vehicleModel,
      vehicle_color: body.vehicle_color || body.vehicleColor,
      license_plate: body.license_plate || body.licensePlate,
      insurance_provider: body.insurance_provider || body.insuranceProvider,
      insurance_policy_number: body.insurance_policy_number || body.policyNumber,
      insurance_expiry: body.insurance_expiry || body.policyExpiry,
      background_check_consent: body.background_check_consent || body.bgConsent || false,
      status: 'pending',
    };

    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_KEY
    );

    const { data, error } = await supabase
      .from('applications')
      .insert([applicationData])
      .select()
      .single();

    if (error) throw error;

    return {
      statusCode: 201,
      headers,
      body: JSON.stringify({ success: true, applicationId: data.id }),
    };
  } catch (err) {
    console.error('Error submitting application:', err);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'Failed to submit application', message: err.message }),
    };
  }
};
