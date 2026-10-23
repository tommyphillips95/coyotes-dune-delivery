/**
 * Per-IP rate limit for public write endpoints. Reuses the admin_login_attempts
 * table (schema/admin_login_attempts.sql, LAUNCH Step 9) with keys
 * "rl:<endpoint>:<ip>": failures = requests in the current window,
 * first_failed_at = window start. No new schema.
 *
 * Limits are deliberately generous: a real customer retrying a checkout or
 * re-submitting a form never gets close. They only stop scripted floods.
 *
 * Fails OPEN: no Supabase, a missing table or any error lets the request
 * through (with a warning). A broken limiter must never block a real order.
 */
"use strict";

const { clientIp, TABLE } = require("./_login-limit");

const WINDOW_MS = 15 * 60 * 1000;
const RATE_LIMITS = {
  "create-order": 30,
  "submit-application": 20,
  "log-analytics-event": 600,
};

function isMissingTable(error) {
  const t = String((error && (error.message || error.details)) || "");
  return !!error && (error.code === "42P01" || error.code === "PGRST205" || /does not exist|could not find the table/i.test(t));
}

function warn(name, error) {
  if (isMissingTable(error)) console.warn(`[rate-limit] ${TABLE} table missing; ${name} rate limit is OFF until schema/${TABLE}.sql runs`);
  else console.warn(`[rate-limit] ${name} check failed; continuing without it:`, (error && error.code) || "error");
}

/** Counts this request. Returns { limited: true, retryAfterSec } or { limited: false }. Never throws. */
async function hit(supabase, event, name, now) {
  const limit = RATE_LIMITS[name];
  if (!supabase || !limit) return { limited: false };
  try {
    const key = "rl:" + name + ":" + clientIp(event);
    const t = now || Date.now();
    const iso = new Date(t).toISOString();
    const { data: row, error } = await supabase.from(TABLE).select("key, failures, first_failed_at").eq("key", key).maybeSingle();
    if (error) { warn(name, error); return { limited: false }; }
    const start = row && row.first_failed_at ? Date.parse(row.first_failed_at) : NaN;
    const fresh = !row || !Number.isFinite(start) || t - start >= WINDOW_MS;
    const count = fresh ? 1 : (Number(row.failures) || 0) + 1;
    if (!fresh && count > limit) {
      return { limited: true, retryAfterSec: Math.max(1, Math.ceil((start + WINDOW_MS - t) / 1000)) };
    }
    const patch = { failures: count, first_failed_at: fresh ? iso : row.first_failed_at, locked_until: null, updated_at: iso };
    const { error: wErr } = row
      ? await supabase.from(TABLE).update(patch).eq("key", key)
      : await supabase.from(TABLE).insert([Object.assign({ key }, patch)]);
    if (wErr) warn(name, wErr);
    return { limited: false };
  } catch (e) {
    warn(name, e);
    return { limited: false };
  }
}

function tooMany(headers, retryAfterSec) {
  return {
    statusCode: 429,
    headers: Object.assign({}, headers, { "Retry-After": String(retryAfterSec) }),
    body: JSON.stringify({ error: "Too many requests. Please wait a few minutes and try again.", retryAfterSec }),
  };
}

module.exports = { hit, tooMany, RATE_LIMITS, WINDOW_MS };
