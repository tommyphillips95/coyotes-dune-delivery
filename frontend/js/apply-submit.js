/* Driver application submit helpers (pure, testable).
   The apply page must only show "submitted" when the server confirmed it:
   2xx + JSON + an applicationId. Anything else is an honest failure. */
(function (root) {
  "use strict";

  var SUBMIT_ERROR_MESSAGE =
    "We couldn't submit your application right now. Please try again later or contact us.";

  // Never written to localStorage (the in-page form still keeps them on failure).
  var SENSITIVE_FIELDS = ["ssn", "accountNumber", "confirmAccountNumber", "routingNumber"];

  // Insurance card limits; same as netlify/functions/_insurance-card.js.
  var INSURANCE_MAX_BYTES = 4 * 1024 * 1024;
  var INSURANCE_TYPES = ["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif", "application/pdf"];
  var INSURANCE_EXTS = ["jpg", "jpeg", "png", "webp", "heic", "heif", "pdf"];

  /** null when the picked file is OK, else a message for the applicant. */
  function checkInsuranceFile(file) {
    if (!file) return "Please upload your insurance card.";
    var ext = String(file.name || "").split(".").pop().toLowerCase();
    var type = String(file.type || "").toLowerCase();
    if (INSURANCE_TYPES.indexOf(type) === -1 && INSURANCE_EXTS.indexOf(ext) === -1) {
      return "Your insurance card must be a JPG, PNG, WebP, HEIC or PDF file.";
    }
    if (file.size > INSURANCE_MAX_BYTES) {
      return "Your insurance card file is too large (" + (Math.ceil(file.size / (1024 * 1024) * 10) / 10).toFixed(1) + " MB). The limit is 4 MB. Please upload a smaller photo or PDF.";
    }
    if (!file.size) return "That file is empty. Please choose your insurance card again.";
    return null;
  }

  function stripSensitive(data) {
    var out = {};
    Object.keys(data || {}).forEach(function (k) {
      if (SENSITIVE_FIELDS.indexOf(k) === -1) out[k] = data[k];
    });
    return out;
  }

  /**
   * POST the application. Resolves { ok: true, applicationId } only on a
   * confirmed save; otherwise { ok: false, reason }. Never throws.
   */
  async function sendApplication(fetchFn, url, init) {
    var res;
    try {
      res = await fetchFn(url, init);
    } catch (err) {
      return { ok: false, reason: "network" };
    }
    if (!res || !res.ok) {
      var fail = { ok: false, reason: "http_" + (res ? res.status : 0) };
      // 4xx answers from submit-application carry a message written for the
      // applicant (missing vehicle type, file too large, ...). Show those.
      if (res && res.status >= 400 && res.status < 500 && typeof res.json === "function") {
        try {
          var errBody = await res.json();
          if (errBody && typeof errBody.error === "string" && errBody.error.trim()) {
            fail.message = errBody.error;
            if (typeof errBody.field === "string") fail.field = errBody.field;
          }
        } catch (e) { /* not JSON: keep the generic message */ }
      }
      return fail;
    }
    var body;
    try {
      body = await res.json();
    } catch (err) {
      return { ok: false, reason: "bad_json" };
    }
    var id = body && body.applicationId;
    if ((typeof id !== "string" || !id.trim()) && typeof id !== "number") {
      return { ok: false, reason: "no_application_id" };
    }
    return { ok: true, applicationId: String(id) };
  }

  var api = {
    SUBMIT_ERROR_MESSAGE: SUBMIT_ERROR_MESSAGE,
    SENSITIVE_FIELDS: SENSITIVE_FIELDS,
    stripSensitive: stripSensitive,
    INSURANCE_MAX_BYTES: INSURANCE_MAX_BYTES,
    checkInsuranceFile: checkInsuranceFile,
    sendApplication: sendApplication
  };
  root.CoyoteApplySubmit = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
