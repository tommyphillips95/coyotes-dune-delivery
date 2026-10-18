/**
 * Admin order changes: assign/unassign a driver and move order status.
 * Used by the admin router (PUT /api/admin/orders/:id) and the older
 * PATCH /api/update-order, so both enforce the same rules:
 *   - status moves only along TRANSITIONS (no reopening completed/cancelled)
 *   - payment state is never set here (Stripe webhook owns payment_status /
 *     final_price); requests that try are refused
 *   - a driver must exist, be approved, and fit the order's vehicle class
 *     (same rule as auto-dispatch, in _vehicle.js: 4x4 orders need a
 *     4x4/utv/awd vehicle that an admin has verified)
 *   - every change writes order_status_logs: who, from -> to, driver
 * Errors are thrown with .status (4xx) and .code so callers can answer with
 * a clear message; anything else is a 500 via _errors.serverError.
 */
"use strict";

const { requiredClass } = require("./zones");
const vehicle = require("./_vehicle");

const STATUSES = ["pending", "assigned", "in_progress", "completed", "cancelled"];
const TRANSITIONS = {
  pending: ["assigned", "cancelled"],
  assigned: ["in_progress", "pending", "cancelled"], // pending = unassign the driver
  in_progress: ["completed", "cancelled"],
  completed: [],
  cancelled: [],
};
const NEEDS_CONFIRM = ["cancelled"];
const PAYMENT_FIELDS = ["payment_status", "final_price", "paid", "stripe_payment_intent_id", "amount", "estimated_price"];
const NOTE_MAX = 500;

function fail(status, code, message, extra) {
  const err = new Error(message);
  err.status = status; err.code = code; err.orderRule = true;
  err.publicMessage = message; // written for the dispatcher; safe to show
  if (extra) err.extra = extra;
  return err;
}

/** 4xx response for a rule we raised on purpose; null for anything else (-> serverError). */
function ruleResponse(headers, err) {
  if (!err || err.orderRule !== true) return null;
  return { statusCode: err.status, headers, body: JSON.stringify(Object.assign({ error: err.publicMessage, code: err.code }, err.extra || {})) };
}

function label(s) { return String(s || "pending").replace(/_/g, " "); }
function driverName(d) { return d ? [d.first_name, d.last_name ? d.last_name.charAt(0) + "." : ""].filter(Boolean).join(" ") : ""; }
/** Driver row (vehicle_class + vehicle_class_verified_at) fits the order's class? */
function canDrive(need, d) { return vehicle.vehicleCheck(need, d).ok; }
function allowedNext(status) { return TRANSITIONS[STATUSES.includes(status) ? status : "pending"].slice(); }

/** Driver choices for an order: [{ id, name, vehicle_class, vehicle_verified, online, eligible, reason }] */
function driverOptions(drivers, order) {
  const need = (order && order.required_vehicle_class) || requiredClass(order.pickup_city, order.dropoff_city || order.pickup_city);
  return (drivers || []).map((d) => {
    const chk = vehicle.vehicleCheck(need, d);
    return { id: d.id, name: driverName(d), vehicle_class: vehicle.classOf(d), vehicle_verified: vehicle.isVerified(d),
      online: d.online === true, beach_permit_ok: d.beach_permit_ok === true, eligible: chk.ok, reason: chk.reason };
  });
}

/**
 * body: { status?, driver_id?, note?, confirm? }  actor: admin user name
 * Returns { order, from, to, driver, warnings, log }.
 */
async function changeOrder(supabase, orderId, body, actor) {
  const b = body || {};
  const tried = PAYMENT_FIELDS.filter((f) => Object.prototype.hasOwnProperty.call(b, f));
  if (tried.length) throw fail(400, "payment_fields_forbidden", `Payment details (${tried.join(", ")}) are set by Stripe, not here.`);
  if (!orderId) throw fail(400, "order_required", "Order ID is required.");
  const wantDriver = b.driver_id != null && String(b.driver_id).trim() !== "" ? String(b.driver_id).trim() : null;
  let to = b.status != null && String(b.status).trim() !== "" ? String(b.status).trim().toLowerCase() : null;
  if (to && !STATUSES.includes(to)) {
    const why = /paid|refund/.test(to) ? " Payment state is set by Stripe, not by order status." : "";
    throw fail(400, "invalid_status", `"${to.slice(0, 30)}" isn't an order status. Use one of: ${STATUSES.join(", ")}.${why}`);
  }
  if (!to && !wantDriver) throw fail(400, "nothing_to_change", "Send a status or a driver_id.");
  const note = b.note == null ? "" : String(b.note).trim().slice(0, NOTE_MAX);

  const { data: order, error } = await supabase.from("orders")
    .select("id, order_number, status, driver_id, required_vehicle_class, pickup_city, dropoff_city, weather_hold")
    .eq("id", orderId).maybeSingle();
  if (error) throw error;
  if (!order) throw fail(404, "order_not_found", "Order not found.");
  const from = STATUSES.includes(order.status) ? order.status : "pending";
  if (wantDriver && !to) to = "assigned";

  // ── driver checks ──
  const warnings = [];
  let driver = null;
  if (wantDriver) {
    if (!["pending", "assigned"].includes(from)) throw fail(409, "invalid_transition", `Can't change the driver of a ${label(from)} order.`);
    if (to !== "assigned") throw fail(400, "invalid_combo", "Assigning a driver sets the status to assigned.");
    const { data: d, error: dErr, verificationReady } = await vehicle.selectWithVerification(
      (cols) => supabase.from("applications").select(cols).eq("id", wantDriver).maybeSingle(),
      "id, first_name, last_name, phone, status, vehicle_class, online, beach_permit_ok", "order-admin");
    if (dErr) throw dErr;
    if (!d) throw fail(404, "driver_not_found", "Driver not found.");
    if (d.status !== "approved") throw fail(422, "driver_not_approved", `${driverName(d)} isn't an approved driver (status: ${label(d.status)}).`);
    const need = order.required_vehicle_class || requiredClass(order.pickup_city, order.dropoff_city || order.pickup_city);
    const chk = vehicle.vehicleCheck(need, d);
    if (chk.code === "class") {
      throw fail(422, "driver_ineligible", `${order.order_number} needs a ${need}; ${driverName(d)} drives ${vehicle.classOf(d)}.`);
    }
    if (chk.code === "unverified") {
      throw fail(422, "vehicle_unverified", verificationReady
        ? `${order.order_number} needs a verified ${need}; ${driverName(d)}'s ${vehicle.classOf(d)} isn't verified yet. Verify it in Applications first.`
        : `${order.order_number} needs a verified ${need}. ${vehicle.SETUP_MESSAGE}`);
    }
    if (d.online !== true) warnings.push(`${driverName(d)} is offline; call them to confirm.`);
    if (need === "4x4" && d.beach_permit_ok !== true) warnings.push(`${driverName(d)} has no beach permit on file.`);
    if (from === "assigned" && order.driver_id === d.id) throw fail(409, "no_change", `${driverName(d)} is already assigned.`);
    driver = d;
  }

  // ── status checks ──
  const reassign = from === "assigned" && to === "assigned" && !!driver;
  if (!reassign) {
    if (to === from) throw fail(409, "no_change", `Order is already ${label(from)}.`);
    if (!TRANSITIONS[from].includes(to)) {
      const next = TRANSITIONS[from];
      throw fail(409, "invalid_transition", `Can't move a ${label(from)} order to ${label(to)}.` + (next.length ? ` Allowed: ${next.map(label).join(", ")}.` : " It's closed."), { allowed: next });
    }
  }
  if (to === "assigned" && !driver && !order.driver_id) throw fail(422, "driver_required", "Pick a driver to assign.");
  if (["assigned", "in_progress"].includes(to) && order.weather_hold) throw fail(409, "weather_hold", "This order is on weather hold. Clear the hold first.");
  if (NEEDS_CONFIRM.includes(to) && b.confirm !== true) throw fail(400, "confirm_required", `Confirm to mark ${order.order_number} ${label(to)}; this can't be undone here.`);

  // ── write (only if nobody changed it since we read it) ──
  const now = new Date().toISOString();
  const patch = { status: to, updated_at: now };
  if (driver) { patch.driver_id = driver.id; patch.assigned_at = now; }
  if (to === "pending") patch.driver_id = null; // unassign
  if (to === "completed") patch.completed_at = now;
  let q = supabase.from("orders").update(patch).eq("id", order.id).eq("status", order.status);
  const { data: rows, error: uErr } = await q.select();
  if (uErr) throw uErr;
  const updated = Array.isArray(rows) ? rows[0] : rows;
  if (!updated) throw fail(409, "conflict", "This order changed while you were editing it. Refresh and try again.");

  // An admin decision ends any open auto-offer for this order.
  if (to !== from || driver) {
    await supabase.from("dispatch_offers").update({ status: "expired", responded_at: now }).eq("order_id", order.id).eq("status", "offered");
  }

  const prevDriver = order.driver_id && (!driver || driver.id !== order.driver_id) ? order.driver_id : null;
  const parts = [`Admin ${actor || "admin"}: status ${label(from)} → ${label(to)}`];
  if (driver) parts.push(`driver ${driverName(driver)} (${vehicle.classOf(driver)})`);
  if (to === "pending" && prevDriver) parts.push("driver unassigned");
  else if (driver && prevDriver) parts.push("replaces previous driver");
  let text = parts.join("; ") + ".";
  if (warnings.length) text += " Warning: " + warnings.join(" ");
  if (note) text += " Note: " + note;
  const log = { order_id: order.id, status: to, note: text, changed_by: "admin:" + String(actor || "admin").slice(0, 60), created_at: now };
  const { error: lErr } = await supabase.from("order_status_logs").insert([log]);
  if (lErr) console.error("[order-admin] status log failed", lErr.message || lErr);

  return { order: updated, from, to, driver, warnings, log };
}

module.exports = { ruleResponse, STATUSES, TRANSITIONS, NEEDS_CONFIRM, PAYMENT_FIELDS, changeOrder, driverOptions, allowedNext, driverName, canDrive };
