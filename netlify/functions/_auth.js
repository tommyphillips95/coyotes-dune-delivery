/**
 * Shared JWT auth helpers for Netlify functions.
 * Fail closed when JWT_SECRET is unset. No hardcoded secrets.
 */
const jwt = require("jsonwebtoken");

function bearerToken(event) {
  const h = event.headers || {};
  const raw = h.authorization || h.Authorization || "";
  return raw.replace(/^Bearer\s+/i, "").trim();
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

function jsonError(headers, err) {
  const status = err.status || 500;
  return {
    statusCode: status,
    headers,
    body: JSON.stringify({ error: err.message || "Error" }),
  };
}

module.exports = {
  bearerToken,
  verifyToken,
  requireAdmin,
  requireAdminOrCustomer,
  issueTrackingToken,
  jsonError,
  authError,
};
