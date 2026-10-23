/**
 * Driver portal responses: only approved drivers get in, and only the fields
 * the portal page shows. Never date of birth, insurance policy number,
 * documents, background-check data or admin notes.
 */
const PENDING_REVIEW = "Your application is pending review. You can log in once it's approved.";

const FIELDS = [
  "id", "status", "first_name", "last_name", "email", "phone",
  "address", "city", "state", "zip",
  "vehicle_year", "vehicle_make", "vehicle_model", "insurance_provider",
];

function publicProfile(app) {
  const out = {};
  for (const k of FIELDS) if (app && app[k] !== undefined) out[k] = app[k];
  out.name = [app && app.first_name, app && app.last_name].filter(Boolean).join(" ");
  out.vehicle_plate = app ? app.license_plate : undefined;
  return out;
}

function pendingReview(headers) {
  return { statusCode: 403, headers, body: JSON.stringify({ error: PENDING_REVIEW, code: "pending_review" }) };
}

module.exports = { publicProfile, pendingReview, PENDING_REVIEW, FIELDS };
