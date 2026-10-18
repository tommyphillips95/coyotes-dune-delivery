/* Driver application submit helpers (pure, testable).
   The apply page must only show "submitted" when the server confirmed it:
   2xx + JSON + an applicationId. Anything else is an honest failure. */
(function (root) {
  "use strict";

  var SUBMIT_ERROR_MESSAGE =
    "We couldn't submit your application right now. Please try again later or contact us.";

  // Never written to localStorage (the in-page form still keeps them on failure).
  var SENSITIVE_FIELDS = ["ssn", "accountNumber", "confirmAccountNumber", "routingNumber"];

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
    if (!res || !res.ok) return { ok: false, reason: "http_" + (res ? res.status : 0) };
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
    sendApplication: sendApplication
  };
  root.CoyoteApplySubmit = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
