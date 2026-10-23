/**
 * Admin login rate limit + lockout, stored in Supabase so it holds across
 * serverless instances (table: admin_login_attempts, schema/admin_login_attempts.sql).
 *
 * Two counters, each a row keyed by `key`:
 *   ip:<client ip>  5 failures within 15 min -> locked for 15 min
 *   user:<username> 20 failures within 15 min -> locked for 15 min
 *     (caps guessing spread across many IPs; a success clears both)
 *
 * Fails OPEN: if Supabase isn't configured, the table is missing, or any query
 * errors, login proceeds without a limit (the password check is still
 * timing-safe) and a warning is logged. A broken limiter must not lock the
 * owner out of admin.
 */
"use strict";

const TABLE = "admin_login_attempts";
const WINDOW_MS = 15 * 60 * 1000;
const LOCK_MS = 15 * 60 * 1000;
const LIMITS = { ip: 5, user: 20 };

function clientIp(event) {
  const h = event.headers || {};
  const get = (n) => { for (const k of Object.keys(h)) if (k.toLowerCase() === n) return h[k]; return ""; };
  const ip = get("x-nf-client-connection-ip") || String(get("x-forwarded-for") || "").split(",")[0];
  return String(ip || "unknown").trim().slice(0, 64) || "unknown";
}

function keysFor(event, username) {
  return [
    { key: "ip:" + clientIp(event), limit: LIMITS.ip },
    { key: "user:" + String(username || "").trim().toLowerCase().slice(0, 100), limit: LIMITS.user },
  ];
}

function isMissingTable(error) {
  const t = String((error && (error.message || error.details)) || "");
  return !!error && (error.code === "42P01" || error.code === "PGRST205" || /does not exist|could not find the table/i.test(t));
}

function warn(error, what) {
  if (isMissingTable(error)) console.warn(`[login-admin] ${TABLE} table missing; login rate limit is OFF until schema/${TABLE}.sql runs`);
  else console.warn(`[login-admin] rate limit ${what} failed; continuing without it:`, (error && error.code) || "error");
}

async function readRows(supabase, keys) {
  const { data, error } = await supabase.from(TABLE).select("key, failures, first_failed_at, locked_until").in("key", keys.map((k) => k.key));
  if (error) { warn(error, "read"); return null; }
  return data || [];
}

/** { locked: true, retryAfterSec } | { locked: false }. Never throws. */
async function checkLocked(supabase, event, username, now) {
  if (!supabase) return { locked: false };
  try {
    const rows = await readRows(supabase, keysFor(event, username));
    if (!rows) return { locked: false };
    const t = now || Date.now();
    let until = 0;
    for (const r of rows) {
      const u = r.locked_until ? Date.parse(r.locked_until) : 0;
      if (u > t && u > until) until = u;
    }
    return until ? { locked: true, retryAfterSec: Math.ceil((until - t) / 1000) } : { locked: false };
  } catch (e) {
    warn(e, "check");
    return { locked: false };
  }
}

/** Count one failure on each key; lock a key when it reaches its limit. Never throws. */
async function recordFailure(supabase, event, username, now) {
  if (!supabase) return;
  try {
    const keys = keysFor(event, username);
    const rows = await readRows(supabase, keys);
    if (!rows) return;
    const t = now || Date.now();
    const iso = new Date(t).toISOString();
    for (const k of keys) {
      const row = rows.find((r) => r.key === k.key);
      const fresh = !row || !row.first_failed_at || t - Date.parse(row.first_failed_at) > WINDOW_MS;
      const failures = fresh ? 1 : (Number(row.failures) || 0) + 1;
      const patch = {
        failures,
        first_failed_at: fresh ? iso : row.first_failed_at,
        locked_until: failures >= k.limit ? new Date(t + LOCK_MS).toISOString() : (row && row.locked_until) || null,
        updated_at: iso,
      };
      const { error } = row
        ? await supabase.from(TABLE).update(patch).eq("key", k.key)
        : await supabase.from(TABLE).insert([Object.assign({ key: k.key }, patch)]);
      if (error) { warn(error, "write"); return; }
    }
  } catch (e) {
    warn(e, "record");
  }
}

/** A successful login clears both counters. Never throws. */
async function clearFailures(supabase, event, username) {
  if (!supabase) return;
  try {
    for (const k of keysFor(event, username)) {
      const { error } = await supabase.from(TABLE).update({ failures: 0, first_failed_at: null, locked_until: null, updated_at: new Date().toISOString() }).eq("key", k.key);
      if (error) { warn(error, "clear"); return; }
    }
  } catch (e) {
    warn(e, "clear");
  }
}

module.exports = { checkLocked, recordFailure, clearFailures, clientIp, LIMITS, WINDOW_MS, LOCK_MS, TABLE };
