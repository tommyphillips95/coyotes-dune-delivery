/**
 * Netlify Function: Submit Driver Application
 * POST /api/applications
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

    const applicationData = {
      first_name: body.first_name || body.firstName,
      last_name: body.last_name || body.lastName,
      email: body.email,
      phone: body.phone,
      date_of_birth: body.date_of_birth || body.dob,
      ssn: body.ssn,
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
      bank_account_name: body.bank_account_name || body.accountType || body.bank_name,
      bank_account_number: body.bank_account_number || body.accountNumber,
      bank_routing_number: body.bank_routing_number || body.routingNumber,
      bank_name: body.bank_name || body.bankName,
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
