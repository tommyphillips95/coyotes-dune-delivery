/**
 * Netlify Function: Submit Driver Application
 * POST /api/submit-application (also /api/applications via redirect)
 *
 * Does not accept or store SSN or bank account fields. Those go through
 * Checkr and Stripe Connect after approval.
 */

const { createClient } = require('@supabase/supabase-js');
const { serverError } = require('./_errors');
const cors = require('./_cors');
const vehicle = require('./_vehicle');

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

    // Self-reported vehicle class (required). Stored as-is; it does not make
    // anyone eligible for beach (4x4) orders until an admin verifies it
    // (PUT /api/admin/applications/:id/vehicle, rules in _vehicle.js).
    const vehicleClass = vehicle.normalizeClass(body.vehicle_class != null ? body.vehicle_class : body.vehicleClass);
    if (!vehicleClass) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'Please choose your vehicle type (' + vehicle.VEHICLE_CLASSES.join(', ') + ').', field: 'vehicleClass' }),
      };
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
      vehicle_class: vehicleClass,
      vehicle_class_reported: vehicleClass,
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

    const insert = (row) => supabase.from('applications').insert([row]).select().single();
    let { data, error } = await insert(applicationData);
    if (error && vehicle.isMissingVehicleColumn(error)) {
      // schema/vehicle_verification.sql not run yet: keep the class in
      // vehicle_class (unverified either way) and save the application.
      console.warn('[submit-application] applications.vehicle_class_reported missing; saving without it');
      const row = Object.assign({}, applicationData);
      delete row.vehicle_class_reported;
      ({ data, error } = await insert(row));
    }

    if (error) throw error;

    return {
      statusCode: 201,
      headers,
      body: JSON.stringify({ success: true, applicationId: data.id }),
    };
  } catch (err) {
    return serverError(headers, err, 'Failed to submit application', 'submit-application');
  }
};
