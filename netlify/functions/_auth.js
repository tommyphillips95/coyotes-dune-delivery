/**
 * Shared JWT auth helpers for Netlify functions.
 * Fail closed when JWT_SECRET is unset. No hardcoded secrets.
 */
const jwt = require("jsonwebtoken");
const { errorResponse } = require("./_errors");

function bearerToken(event) {
  const h = event.headers || {};
  const raw = h.authorization || h.Authorization || "";
  return raw.replace(/^Bearer\s+/i, "").trim();
}

function header(event, name) {
  const h = event.headers || {};
  const lower = name.toLowerCase();
  for (const k of Object.keys(h)) {
    if (k.toLowerCase() === lower) return h[k];
  }
  return undefined;
}

function authError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

/** Verify Bearer JWT; throws {status, message}. */
function verifyToken(event) {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw authError(500, "Auth not configured");
  const token = bearerToken(event);
  if (!token) throw authError(401, "Unauthorized");
  try {
    return jwt.verify(token, secret);
  } catch (e) {
    throw authError(401, "Invalid token");
  }
}

/** Admin-only. Matches get-applications / checkr pattern. */
function requireAdmin(event) {
  const decoded = verifyToken(event);
  if (decoded.role !== "admin") throw authError(403, "Admin access required");
  return decoded;
}

/**
 * Admin JWT, or customer tracking JWT scoped to an order.
 * Customer tokens: { role: 'customer', order_id, order_number }.
 */
function requireAdminOrCustomer(event) {
  const decoded = verifyToken(event);
  if (decoded.role === "admin") return { kind: "admin", decoded };
  if (decoded.role === "customer" && decoded.order_id) {
    return { kind: "customer", decoded };
  }
  throw authError(403, "Forbidden");
}

/** Driver JWT: { role: 'driver', driver_id }. */
function requireDriver(event) {
  const decoded = verifyToken(event);
  if (decoded.role !== "driver" || !decoded.driver_id) {
    throw authError(403, "Driver access required");
  }
  return decoded;
}

/** Admin or the authenticated driver. */
function requireAdminOrDriver(event) {
  const decoded = verifyToken(event);
  if (decoded.role === "admin") return { kind: "admin", decoded };
  if (decoded.role === "driver" && decoded.driver_id) {
    return { kind: "driver", decoded };
  }
  throw authError(403, "Forbidden");
}

/**
 * True for Netlify scheduled invocations (cron), which must not require a browser JWT.
 * See https://docs.netlify.com/functions/scheduled-functions/
 */
function isNetlifySchedule(event) {
  const v = header(event, "x-netlify-event");
  return String(v || "").toLowerCase() === "schedule";
}

/**
 * Shared secret for machine-to-machine HTTP (optional env INTERNAL_FUNCTION_SECRET).
 * Header: x-internal-secret
 */
function hasInternalSecret(event) {
  const expected = process.env.INTERNAL_FUNCTION_SECRET;
  if (!expected) return false;
  const got = header(event, "x-internal-secret");
  return Boolean(got && got === expected);
}

/**
 * Admin JWT, Netlify schedule, or internal shared-secret header.
 * Used by expire-offers (cron + manual) and offer-next (manual/admin).
 */
function requireAdminOrInternal(event) {
  if (isNetlifySchedule(event)) return { kind: "schedule" };
  if (hasInternalSecret(event)) return { kind: "internal" };
  return { kind: "admin", decoded: requireAdmin(event) };
}

/**
 * get-driver-location: admin, assigned driver, or customer tracking token for that order.
 * Pass resolved location row (with driver_id / order_id) after fetch, or ids from the query.
 */
function assertLocationAccess(auth, location) {
  if (!auth) throw authError(401, "Unauthorized");
  if (auth.kind === "admin") return;
  if (auth.kind === "driver") {
    if (!location || auth.decoded.driver_id !== location.driver_id) {
      throw authError(403, "Forbidden");
    }
    return;
  }
  if (auth.kind === "customer") {
    if (!location || !location.order_id || auth.decoded.order_id !== location.order_id) {
      throw authError(403, "Forbidden");
    }
    return;
  }
  throw authError(403, "Forbidden");
}

/** Classify bearer for location reads without throwing on wrong role first. */
function requireLocationCaller(event) {
  const decoded = verifyToken(event);
  if (decoded.role === "admin") return { kind: "admin", decoded };
  if (decoded.role === "driver" && decoded.driver_id) {
    return { kind: "driver", decoded };
  }
  if (decoded.role === "customer" && decoded.order_id) {
    return { kind: "customer", decoded };
  }
  throw authError(403, "Forbidden");
}

/** Short-lived customer tracking token issued after order create or track login. */
function issueTrackingToken(order) {
  const secret = process.env.JWT_SECRET;
  if (!secret) return null;
  return jwt.sign(
    {
      role: "customer",
      order_id: order.id,
      order_number: order.order_number,
    },
    secret,
    { expiresIn: "7d" }
  );
}

/** Driver portal token after get-status possession check (applicantId + email). */
function issueDriverToken(driverId) {
  const secret = process.env.JWT_SECRET;
  if (!secret) return null;
  return jwt.sign(
    {
      role: "driver",
      driver_id: driverId,
    },
    secret,
    { expiresIn: "7d" }
  );
}

function jsonError(headers, err) {
  // 4xx auth/validation messages are meant for the caller; 5xx detail is logged only.
  return errorResponse(headers, err, "Server error", "auth");
}

/**
 * A driver JWT lives 7 days; approval can be revoked sooner. Every driver
 * request re-reads applications.status so a removed driver is rejected at once.
 * Admin/customer callers pass through.
 */
async function assertDriverActive(supabase, auth) {
  if (!auth || auth.kind !== "driver") return;
  const id = auth.decoded && auth.decoded.driver_id;
  const { data, error } = await supabase.from("applications").select("id, status").eq("id", id).maybeSingle();
  if (error) throw error;
  if (!data || data.status !== "approved") throw authError(403, "Your driver access is no longer active.");
}

module.exports = {
  assertDriverActive,
  bearerToken,
  verifyToken,
  requireAdmin,
  requireAdminOrCustomer,
  requireDriver,
  requireAdminOrDriver,
  requireAdminOrInternal,
  requireLocationCaller,
  assertLocationAccess,
  isNetlifySchedule,
  hasInternalSecret,
  issueTrackingToken,
  issueDriverToken,
  jsonError,
  authError,
};
