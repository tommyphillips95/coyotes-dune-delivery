/**
 * Netlify Function: Admin router (#33)
 * Serves the dashboard contract under /api/admin/* (netlify.toml maps
 * /api/* to /.netlify/functions/:splat, so these all land here):
 *
 *   POST /api/admin/login                      -> login-admin
 *   GET  /api/admin/applications               -> list applications
 *   PUT  /api/admin/applications/:id           -> status, notes, beach permit
 *   PUT  /api/admin/applications/:id/vehicle   -> set + verify vehicle class
 *                                                 { vehicle_class, verified } (logged
 *                                                 in notes; rules in _vehicle.js)
 *   POST /api/admin/applications/bulk          -> bulk status
 *   GET  /api/admin/orders                     -> recent orders + weather_hold, payment
 *                                                 label, "needs attention" flags, history
 *                                                 + approved drivers and allowed next statuses
 *   PUT  /api/admin/orders/:id                 -> assign driver / change status
 *                                                 { status?, driver_id?, note?, confirm? }
 *                                                 rules in _order-admin.js
 *   GET  /api/admin/drivers                    -> approved drivers (for the assign select)
 *   PUT  /api/admin/orders/:id/weather-hold    -> set/clear per-order hold
 *   GET  /api/admin/weather                    -> read-only WEATHER_SHUTDOWN state
 *
 * Deleting applications is not supported here on purpose (set status instead).
 */
const { createClient } = require("@supabase/supabase-js");
const { serverError } = require("./_errors");
const { requireAdmin, jsonError } = require("./_auth");
const cors = require("./_cors");
const { weatherShutdownActive, weatherShutdownReason } = require("./_weather");
const loginAdmin = require("./login-admin");
const orderAttention = require("./_order-attention");
const orderAdmin = require("./_order-admin");
const { sendSMS, logSMS } = require("./dispatch");
const vehicle = require("./_vehicle");

const ORDERS_LIMIT = 50;
const LOGS_LIMIT = 1000; // newest logs across the listed orders
const HISTORY_PER_ORDER = 12;

const APP_STATUSES = ["pending", "background_check", "approved", "rejected", "on_hold"];
const NOTES_MAX = 2000;

function db() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
}

function routeParts(event) {
  const p = String(event.path || "");
  const i = p.indexOf("/admin");
  const rest = i >= 0 ? p.slice(i + "/admin".length) : p;
  return rest.split("/").filter(Boolean);
}

function json(headers, statusCode, body) {
  return { statusCode, headers, body: JSON.stringify(body) };
}

function toBool(v) {
  if (typeof v === "boolean") return v;
  const s = String(v).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(s)) return true;
  if (["0", "false", "no", "off", ""].includes(s)) return false;
  return null;
}

/** Shape a DB row for the dashboard (it predates the Supabase column names). */
function shapeApplication(a) {
  const name = a.name || [a.first_name, a.last_name].filter(Boolean).join(" ");
  return Object.assign({}, a, {
    name,
    submitted: a.created_at,
    dob: a.date_of_birth,
    zip: a.zip_code,
    vehicle_plate: a.license_plate,
    insurance_policy: a.insurance_policy_number,
    admin_notes: a.notes,
    beach_permit_ok: a.beach_permit_ok === true,
    beach_access_notes: a.beach_access_notes || "",
    vehicle_class: vehicle.classOf(a),
    vehicle_class_label: vehicle.LABELS[vehicle.classOf(a)],
    vehicle_class_reported: a.vehicle_class_reported || null,
    vehicle_verified: vehicle.isVerified(a),
    vehicle_verification_ready: vehicleColumnsPresent(a),
  });
}

/** select("*") returns every column, so a missing key means the column isn't there yet. */
function vehicleColumnsPresent(row) {
  return !!row && vehicle.VERIFY_COLS.every((c) => Object.prototype.hasOwnProperty.call(row, c));
}

function chicagoStamp(iso) {
  return new Date(iso).toLocaleString("en-US", { timeZone: "America/Chicago", year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) + " CT";
}

/** PUT /applications/:id/vehicle: admin sets the class and says whether they checked it. */
async function setVehicle(supabase, id, body, who, headers) {
  const cls = vehicle.normalizeClass(body.vehicle_class);
  if (!cls) return json(headers, 400, { error: "vehicle_class must be one of: " + vehicle.VEHICLE_CLASSES.join(", ") });
  const verified = typeof body.verified === "boolean" ? body.verified : null;
  if (verified === null) return json(headers, 400, { error: "verified must be true or false" });
  const notReady = () => json(headers, 409, { error: vehicle.SETUP_MESSAGE + " Nothing was saved.", code: "vehicle_columns_missing" });

  const { data: cur, error: cErr } = await supabase.from("applications").select("*").eq("id", id).maybeSingle();
  if (cErr) throw cErr;
  if (!cur) return json(headers, 404, { error: "Application not found" });
  if (!vehicleColumnsPresent(cur)) return notReady();

  const now = new Date().toISOString();
  const line = `[${chicagoStamp(now)}] Vehicle class ${vehicle.classOf(cur)} → ${cls}, ${verified ? "verified" : "marked not verified"} by admin ${who}`
    + (cur.vehicle_class_reported ? ` (driver reported ${cur.vehicle_class_reported})` : "") + ".";
  const patch = {
    vehicle_class: cls,
    vehicle_class_verified_at: verified ? now : null,
    vehicle_class_verified_by: verified ? String(who).slice(0, 120) : null,
    notes: (cur.notes ? cur.notes + "\n" : "") + line,
    updated_at: now,
  };
  const { data, error } = await supabase.from("applications").update(patch).eq("id", id).select().maybeSingle();
  if (error) { if (vehicle.isMissingVehicleColumn(error)) return notReady(); throw error; }
  if (!data) return json(headers, 404, { error: "Application not found" });
  console.log("[admin] application " + id + ": " + line);
  return json(headers, 200, { success: true, log: line, data: shapeApplication(data) });
}

/** Whitelist admin-editable application fields. Returns { patch } or { error }. */
function buildApplicationPatch(body) {
  const patch = {};
  if (body.status !== undefined) {
    if (!APP_STATUSES.includes(body.status)) {
      return { error: "Invalid status. Must be one of: " + APP_STATUSES.join(", ") };
    }
    patch.status = body.status;
  }
  if (body.admin_notes !== undefined) {
    patch.notes = String(body.admin_notes || "").slice(0, NOTES_MAX);
  }
  if (body.beach_permit_ok !== undefined) {
    const b = toBool(body.beach_permit_ok);
    if (b === null) return { error: "beach_permit_ok must be true or false" };
    patch.beach_permit_ok = b;
  }
  if (body.beach_access_notes !== undefined) {
    patch.beach_access_notes = String(body.beach_access_notes || "").slice(0, NOTES_MAX);
  }
  if (!Object.keys(patch).length) return { error: "Nothing to update" };
  patch.updated_at = new Date().toISOString();
  return { patch };
}

/**
 * A driver moved off "approved" must stop getting work at once: take them
 * offline, expire their open offers, and list orders still assigned to them
 * (assigned / in progress) so dispatch can reassign. Orders are not changed
 * here; the admin decides via PUT /orders/:id.
 */
async function offboardDrivers(supabase, ids) {
  if (!ids.length) return { active_orders: [], warning: null };
  const now = new Date().toISOString();
  const { error: oErr } = await supabase.from("applications").update({ online: false }).in("id", ids);
  if (oErr) throw oErr;
  const { error: fErr } = await supabase.from("dispatch_offers").update({ status: "expired", responded_at: now }).in("driver_id", ids).eq("status", "offered");
  if (fErr) throw fErr;
  const { data, error } = await supabase.from("orders").select("id, order_number, status, driver_id")
    .in("driver_id", ids).in("status", ["assigned", "in_progress"]);
  if (error) throw error;
  const active = (data || []).map((o) => ({ id: o.id, order_number: o.order_number || null, status: o.status, driver_id: o.driver_id }));
  const warning = active.length
    ? `${active.length} active order(s) still assigned to this driver: ${active.map((o) => o.order_number || o.id).join(", ")}. Reassign them in Orders.`
    : null;
  return { active_orders: active, warning };
}

const DRIVER_COLS = "id, first_name, last_name, status, vehicle_class, online, beach_permit_ok";

/** Approved drivers with vehicle verification (if the columns exist yet). Array + .verificationReady */
async function approvedDrivers(supabase) {
  const { data, error, verificationReady } = await vehicle.selectWithVerification(
    (cols) => supabase.from("applications").select(cols).eq("status", "approved"), DRIVER_COLS, "admin");
  if (error) throw error;
  const list = data || [];
  list.verificationReady = verificationReady;
  return list;
}

/** Text the driver about a dispatcher assignment. sendSMS is a no-op without Twilio env. */
async function notifyDriver(supabase, result) {
  const d = result.driver;
  if (!d || !d.phone) return { sent: false, reason: "no_phone" };
  const o = result.order || {};
  const route = [o.pickup_city, o.dropoff_city].filter(Boolean).join(" to ");
  const msg = `Coyote's Dune Delivery: dispatch assigned you ${o.order_number || "an order"}${route ? " (" + route + ")" : ""}. Call dispatch if you can't take it.`;
  const sent = await sendSMS(d.phone, msg);
  await logSMS(supabase, { order_id: o.id, phone_number: d.phone, message: msg, status: sent.success ? "sent" : "failed", twilio_sid: sent.messageSid || null, error: sent.error || null });
  return { sent: !!sent.success, reason: sent.success ? null : sent.error || "failed" };
}

function pick(o, keys, extra) {
  const out = {};
  keys.forEach((k) => { if (o && o[k] !== undefined) out[k] = o[k]; });
  return Object.assign(out, extra || {});
}

function weatherState() {
  const active = weatherShutdownActive();
  return { active, reason: active ? weatherShutdownReason() : null, source: "netlify_env" };
}

exports.handler = async (event) => {
  const headers = cors.headers(event, { "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS" });
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers, body: "" };

  const parts = routeParts(event);
  const method = event.httpMethod;

  if (parts[0] === "login") return loginAdmin.handler(event);

  let admin;
  try {
    admin = requireAdmin(event);
  } catch (err) {
    return jsonError(headers, err);
  }

  let body = {};
  if (event.body) {
    try { body = JSON.parse(event.body); } catch (e) { return json(headers, 400, { error: "Invalid JSON" }); }
  }

  try {
    if (parts[0] === "weather" && method === "GET") {
      return json(headers, 200, weatherState());
    }

    if (parts[0] === "applications") {
      const supabase = db();
      if (parts.length === 1 && method === "GET") {
        const { data, error } = await supabase.from("applications").select("*").order("created_at", { ascending: false });
        if (error) throw error;
        const applications = (data || []).map(shapeApplication);
        const ready = applications.every((a) => a.vehicle_verification_ready);
        return json(headers, 200, { applications, vehicleSetupMessage: ready ? null : vehicle.SETUP_MESSAGE });
      }
      if (parts[1] === "bulk" && method === "POST") {
        const ids = Array.isArray(body.ids) ? body.ids.map(String).filter(Boolean) : [];
        if (!ids.length) return json(headers, 400, { error: "ids required" });
        if (!APP_STATUSES.includes(body.status)) return json(headers, 400, { error: "Invalid status" });
        const { data, error } = await supabase.from("applications")
          .update({ status: body.status, updated_at: new Date().toISOString() })
          .in("id", ids).select();
        if (error) throw error;
        const off = body.status === "approved" ? { active_orders: [], warning: null } : await offboardDrivers(supabase, (data || []).map((a) => a.id));
        return json(headers, 200, Object.assign({ success: true, updated: (data || []).length }, off));
      }
      if (parts.length === 2 && method === "PUT") {
        const { patch, error: bad } = buildApplicationPatch(body);
        if (bad) return json(headers, 400, { error: bad });
        const { data, error } = await supabase.from("applications").update(patch).eq("id", parts[1]).select().maybeSingle();
        if (error) throw error;
        if (!data) return json(headers, 404, { error: "Application not found" });
        const off = patch.status && patch.status !== "approved" ? await offboardDrivers(supabase, [data.id]) : { active_orders: [], warning: null };
        if (patch.status && patch.status !== "approved") data.online = false;
        return json(headers, 200, Object.assign({ success: true, data: shapeApplication(data) }, off));
      }
      if (parts.length === 3 && parts[2] === "vehicle" && method === "PUT") {
        return setVehicle(supabase, parts[1], body, (admin && admin.user) || "admin", headers);
      }
      if (parts.length === 2 && method === "DELETE") {
        return json(headers, 405, { error: "Deleting applications is disabled. Set status to rejected instead." });
      }
    }

    if (parts[0] === "orders") {
      const supabase = db();
      if (parts.length === 1 && method === "GET") {
        const { data, error } = await supabase.from("orders")
          .select("id, order_number, status, payment_status, stripe_payment_intent_id, driver_id, pickup_city, dropoff_city, required_vehicle_class, weather_hold, estimated_price, final_price, is_asap, scheduled_date, scheduled_time, created_at")
          .order("created_at", { ascending: false }).limit(ORDERS_LIMIT);
        if (error) throw error;
        const orders = data || [];
        // Status history (payment, refund, dispatch, address-check notes) so the
        // dashboard can show what needs a person. Logs are optional: if they
        // can't be read the list still loads, flagged as such.
        let logsByOrder = {};
        let logsError = false;
        if (orders.length) {
          const { data: logs, error: lErr } = await supabase.from("order_status_logs")
            .select("order_id, status, note, changed_by, created_at")
            .in("order_id", orders.map((o) => o.id))
            .order("created_at", { ascending: false }).limit(LOGS_LIMIT);
          if (lErr) { console.error("[admin] order_status_logs:", lErr.message || lErr); logsError = true; }
          (logs || []).forEach((l) => { (logsByOrder[l.order_id] = logsByOrder[l.order_id] || []).push(l); });
        }
        const drivers = await approvedDrivers(supabase);
        const byId = {};
        drivers.forEach((d) => { byId[d.id] = d; });
        const shaped = orders.map((o) => {
          const logs = logsByOrder[o.id] || [];
          const out = Object.assign({}, o, {
            driver_name: o.driver_id ? (byId[o.driver_id] ? orderAdmin.driverName(byId[o.driver_id]) : "Driver (not approved)") : null,
            allowed: orderAdmin.allowedNext(o.status),
            driver_options: orderAdmin.driverOptions(drivers, o),
            payment: orderAttention.payment(o, logs),
            attention: orderAttention.attention(o, logs),
            history: orderAttention.newestFirst(logs).slice(0, HISTORY_PER_ORDER)
              .map((l) => ({ status: l.status, note: l.note, by: l.changed_by, at: l.created_at })),
          });
          delete out.stripe_payment_intent_id; // only used for the payment label
          return out;
        });
        return json(headers, 200, { orders: shaped, logsError, weather: weatherState(),
          vehicleSetupMessage: drivers.verificationReady ? null : vehicle.SETUP_MESSAGE });
      }
      if (parts.length === 2 && method === "PUT") {
        const actor = (admin && admin.user) || "admin";
        let result;
        try {
          result = await orderAdmin.changeOrder(supabase, parts[1], body, actor);
        } catch (e) {
          const rule = orderAdmin.ruleResponse(headers, e);
          if (rule) return rule;
          throw e;
        }
        const sms = result.driver ? await notifyDriver(supabase, result) : null;
        return json(headers, 200, {
          success: true, from: result.from, to: result.to, warnings: result.warnings, driverSms: sms,
          customerSms: result.customerSms ? { sent: result.customerSms.sent, reason: result.customerSms.reason } : null,
          order: pick(result.order, ["id", "order_number", "status", "driver_id", "assigned_at", "completed_at", "payment_status"], { allowed: orderAdmin.allowedNext(result.to), driver_name: result.driver ? orderAdmin.driverName(result.driver) : null }),
        });
      }
      if (parts.length === 3 && parts[2] === "weather-hold" && method === "PUT") {
        const hold = toBool(body.weather_hold);
        if (hold === null) return json(headers, 400, { error: "weather_hold must be true or false" });
        const { data, error } = await supabase.from("orders")
          .update({ weather_hold: hold, updated_at: new Date().toISOString() })
          .eq("id", parts[1]).select().maybeSingle();
        if (error) throw error;
        if (!data) return json(headers, 404, { error: "Order not found" });
        await supabase.from("order_status_logs").insert([{
          order_id: parts[1],
          status: data.status,
          note: hold ? "Weather hold set by admin" : "Weather hold cleared by admin",
          changed_by: (admin && admin.user) || "admin",
        }]);
        return json(headers, 200, { success: true, data });
      }
    }

    if (parts[0] === "drivers" && parts.length === 1 && method === "GET") {
      const drivers = await approvedDrivers(db());
      return json(headers, 200, {
        drivers: drivers.map((d) => ({ id: d.id, name: orderAdmin.driverName(d), vehicle_class: vehicle.classOf(d), vehicle_verified: vehicle.isVerified(d), online: d.online === true, beach_permit_ok: d.beach_permit_ok === true })),
        vehicleSetupMessage: drivers.verificationReady ? null : vehicle.SETUP_MESSAGE,
      });
    }

    return json(headers, 404, { error: "Not found" });
  } catch (err) {
    return serverError(headers, err, "Admin request failed", "admin");
  }
};

exports._internal = { routeParts, buildApplicationPatch, shapeApplication, toBool };
