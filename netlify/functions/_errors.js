/**
 * Error responses that are safe to send to a browser.
 *
 * - 4xx errors we raise on purpose (authError, validation, err.status 400-499)
 *   keep their message: those are written for the caller.
 * - Anything else (DB/Stripe/Twilio/Checkr/internal throws, 5xx) is logged here
 *   with full detail and the caller only gets a generic message.
 */
"use strict";

const GENERIC = "Something went wrong. Please try again.";

function clientStatus(err) {
  const s = Number(err && err.status);
  return s >= 400 && s < 500 ? s : 0;
}

function serverError(headers, err, publicMessage, context) {
  console.error("[" + (context || "function") + "]", err);
  const s = Number(err && err.status);
  return {
    statusCode: s >= 500 && s < 600 ? s : 500,
    headers,
    body: JSON.stringify({ error: publicMessage || GENERIC }),
  };
}

function errorResponse(headers, err, publicMessage, context) {
  const s = clientStatus(err);
  if (s) {
    return { statusCode: s, headers, body: JSON.stringify({ error: (err && err.message) || publicMessage || "Request failed" }) };
  }
  return serverError(headers, err, publicMessage, context);
}

module.exports = { GENERIC, clientStatus, serverError, errorResponse };
