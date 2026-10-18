/**
 * Tropical / weather shutdown gate (#13).
 * Flip with Netlify env WEATHER_SHUTDOWN=1 (or true/yes/on).
 * Optional WEATHER_SHUTDOWN_REASON for the customer-facing message.
 */

function truthy(v) {
  if (v == null) return false;
  const s = String(v).trim().toLowerCase();
  return s === "1" || s === "true" || s === "yes" || s === "on";
}

function weatherShutdownActive(env) {
  const e = env || process.env;
  return truthy(e.WEATHER_SHUTDOWN) || truthy(e.COYOTE_WEATHER_HOLD);
}

function weatherShutdownReason(env) {
  const e = env || process.env;
  const custom = (e.WEATHER_SHUTDOWN_REASON || "").trim();
  if (custom) return custom;
  return "Deliveries are paused for weather. Try again once the tropical hold lifts.";
}

function weatherShutdownPayload(env) {
  return {
    error: "weather_hold",
    weather_hold: true,
    message: weatherShutdownReason(env),
  };
}

module.exports = {
  weatherShutdownActive,
  weatherShutdownReason,
  weatherShutdownPayload,
};
