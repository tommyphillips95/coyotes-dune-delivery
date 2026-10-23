/**
 * Netlify Function: Submit Driver Application
 * POST /api/submit-application (also /api/applications via redirect)
 *
 * Does not accept or store SSN or bank account fields. Those go through
 * Checkr and Stripe Connect after approval.
 *
 * Body: the apply page sends multipart/form-data (browser FormData with the
 * required insurance card file, field "insuranceCard"; Netlify passes it
 * base64-encoded). JSON bodies (no file) are still accepted for other callers.
 * File rules and storage: _insurance-card.js.
 */

const { createClient } = require('@supabase/supabase-js');
const { serverError } = require('./_errors');
const cors = require('./_cors');
const vehicle = require('./_vehicle');
const multipart = require('./_multipart');
const card = require('./_insurance-card');

// Whole request cap (file + text fields), checked before parsing.
const MAX_BODY_BYTES = card.MAX_BYTES + 512 * 1024;

function toBool(v) {
  if (v === true) return true;
  return typeof v === 'string' && ['true', 'on', '1', 'yes'].includes(v.trim().toLowerCase());
}

// Consents the apply form requires (field names exactly as the form sends
// them; checkboxes arrive as "true"/"false"). background_check_consent is the
// stored column name, accepted as an alias for bgConsent.
const REQUIRED_CONSENTS = [
  { field: 'bgConsent', alias: 'background_check_consent', error: 'Please consent to the background check to submit your application.' },
  { field: 'bgDisclosureRead', error: 'Please confirm you have read the background check disclosure.' },
  { field: 'esignature', error: 'Please check the box to sign your application electronically.' },
  { field: 'termsAgree', error: 'Please confirm your information and agree to the terms.' },
];

// Consent record columns from schema/driver_consents.sql (LAUNCH.md step 8).
// Until that runs they don't exist; the application is saved without them.
const CONSENT_COLS = ['background_check_disclosure_read', 'esignature_consent', 'terms_consent', 'consents_accepted_at'];

/** True when an insert failed only because a driver_consents.sql column is missing. */
function isMissingConsentColumn(err) {
  if (!err) return false;
  const text = [err.message, err.details, err.hint].filter(Boolean).join(' ');
  const missing = err.code === '42703' || err.code === 'PGRST204' || /does not exist|could not find/i.test(text);
  return missing && CONSENT_COLS.some((c) => text.includes(c));
}

/** First missing/false required consent as { error, field }, or null. */
function missingConsent(body) {
  for (const c of REQUIRED_CONSENTS) {
    if (!toBool(body[c.field]) && !(c.alias && toBool(body[c.alias]))) return { error: c.error, field: c.field };
  }
  return null;
}

/** { body, file } from a multipart or JSON request, or { error: response }. */
function readRequest(event, headers) {
  const fail = (statusCode, error, field) => ({ error: { statusCode, headers, body: JSON.stringify(field ? { error, field } : { error }) } });
  if (multipart.isMultipart(event)) {
    const raw = multipart.eventBody(event);
    if (raw.length > MAX_BODY_BYTES) {
      return fail(413, 'Your application upload is too large. The insurance card file can be up to ' + (card.MAX_BYTES / (1024 * 1024)) + ' MB.', card.FIELD);
    }
    let parsed;
    try {
      parsed = multipart.parseMultipart(raw, multipart.header(event, 'content-type'));
    } catch (err) {
      return fail(err.status || 400, err.message);
    }
    const part = parsed.files.find((f) => f.field === card.FIELD && (f.filename || f.data.length));
    const checked = card.check(part);
    if (!checked.ok) return fail(checked.status, checked.error, card.FIELD);
    return { body: parsed.fields, file: checked.file };
  }
  const text = multipart.eventBody(event).toString('utf8');
  try {
    const body = JSON.parse(text || '{}');
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('not an object');
    return { body, file: null };
  } catch (err) {
    return fail(400, 'The application could not be read. Please try again.');
  }
}

exports.REQUIRED_CONSENTS = REQUIRED_CONSENTS.map((c) => c.field);
exports.CONSENT_COLS = CONSENT_COLS;

exports.handler = async (event) => {
  const headers = cors.headers(event, { 'Content-Type': 'application/json' });

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  try {
    const req = readRequest(event, headers);
    if (req.error) return req.error;
    const body = req.body;

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

    // Required consents: same rule as the form, enforced here too (multipart and JSON).
    const consent = missingConsent(body);
    if (consent) {
      return { statusCode: 400, headers, body: JSON.stringify(consent) };
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
      background_check_consent: toBool(body.background_check_consent) || toBool(body.bgConsent),
      // All four consents were checked above. The time is the server's, never the client's.
      background_check_disclosure_read: true,
      esignature_consent: true,
      terms_consent: true,
      consents_accepted_at: new Date().toISOString(),
      status: 'pending',
    };

    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_KEY
    );

    const insert = (row) => supabase.from('applications').insert([row]).select().single();
    // Columns from SQL files that may not be run yet are dropped on a
    // "column not found" error and the insert retried, with a warning.
    let row = applicationData;
    let { data, error } = await insert(row);
    for (let tries = 0; error && tries < 2; tries++) {
      if (vehicle.isMissingVehicleColumn(error) && 'vehicle_class_reported' in row) {
        // schema/vehicle_verification.sql not run yet: keep the class in
        // vehicle_class (unverified either way) and save the application.
        console.warn('[submit-application] applications.vehicle_class_reported missing; saving without it');
        row = Object.assign({}, row);
        delete row.vehicle_class_reported;
      } else if (isMissingConsentColumn(error) && 'consents_accepted_at' in row) {
        console.warn('[submit-application] consent columns missing (run schema/driver_consents.sql, LAUNCH.md step 8); saving without the consent record');
        row = Object.assign({}, row);
        CONSENT_COLS.forEach((c) => { delete row[c]; });
      } else break;
      ({ data, error } = await insert(row));
    }

    if (error) throw error;

    // The application is saved. Keep the insurance card in Storage; if that
    // fails (e.g. the driver-documents bucket isn't created yet) the applicant
    // still gets their confirmation and admin sees a note to ask for the card.
    let insuranceCardStored = null;
    if (req.file) {
      const saved = await card.store(supabase, data.id, req.file);
      insuranceCardStored = !!saved.stored;
      if (!saved.stored || saved.documentRow === false) {
        const note = saved.stored
          ? 'Insurance card saved to storage (' + saved.path + ') but the documents row failed.'
          : 'Insurance card upload failed (' + saved.reason + '). Ask the driver to send it again.';
        try {
          await supabase.from('applications').update({ notes: note }).eq('id', data.id);
        } catch (e) {
          console.error('[submit-application] could not add upload note:', e && e.message);
        }
      }
    }

    return {
      statusCode: 201,
      headers,
      body: JSON.stringify(Object.assign({ success: true, applicationId: data.id }, req.file ? { insuranceCardStored } : {})),
    };
  } catch (err) {
    return serverError(headers, err, 'Failed to submit application', 'submit-application');
  }
};
