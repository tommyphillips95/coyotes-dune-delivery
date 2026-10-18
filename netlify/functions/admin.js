/**
 * Netlify Function: Admin router (#33)
 * Serves the dashboard contract under /api/admin/* (netlify.toml maps
 * /api/* to /.netlify/functions/:splat, so these all land here):
 *
 *   POST /api/admin/login                      -> login-admin
 *   GET  /api/admin/applications               -> list applications
 *   PUT  /api/admin/applications/:id           -> status, notes, beach permit
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
  });
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

const DRIVER_COLS = "id, first_name, last_name, status, vehicle_class, online, beach_permit_ok";

async function approvedDrivers(supabase) {
  const { data, error } = await supabase.from("applications").select(DRIVER_COLS).eq("status", "approved");
  if (error) throw error;
  return data || [];
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
        return json(headers, 200, { applications: (data || []).map(shapeApplication) });
      }
      if (parts[1] === "bulk" && method === "POST") {
        const ids = Array.isArray(body.ids) ? body.ids.map(String).filter(Boolean) : [];
        if (!ids.length) return json(headers, 400, { error: "ids required" });
        if (!APP_STATUSES.includes(body.status)) return json(headers, 400, { error: "Invalid status" });
        const { data, error } = await supabase.from("applications")
          .update({ status: body.status, updated_at: new Date().toISOString() })
          .in("id", ids).select();
        if (error) throw error;
        return json(headers, 200, { success: true, updated: (data || []).length });
      }
      if (parts.length === 2 && method === "PUT") {
        const { patch, error: bad } = buildApplicationPatch(body);
        if (bad) return json(headers, 400, { error: bad });
        const { data, error } = await supabase.from("applications").update(patch).eq("id", parts[1]).select().maybeSingle();
        if (error) throw error;
        if (!data) return json(headers, 404, { error: "Application not found" });
        return json(headers, 200, { success: true, data: shapeApplication(data) });
      }
      if (parts.length === 2 && method === "DELETE") {
        return json(headers, 405, { error: "Deleting applications is disabled. Set status to rejected instead." });
      }
    }

    if (parts[0] === "orders") {
      const supabase = db();
      if (parts.length === 1 && method === "GET") {
        const { data, error } = await supabase.from("orders")
          .select("id, order_number, status, payment_status, driver_id, pickup_city, dropoff_city, required_vehicle_class, weather_hold, estimated_price, final_price, is_asap, scheduled_date, scheduled_time, created_at")
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
          return Object.assign({}, o, {
            driver_name: o.driver_id ? (byId[o.driver_id] ? orderAdmin.driverName(byId[o.driver_id]) : "Driver (not approved)") : null,
            allowed: orderAdmin.allowedNext(o.status),
            driver_options: orderAdmin.driverOptions(drivers, o),
            payment: orderAttention.payment(o, logs),
            attention: orderAttention.attention(o, logs),
            history: orderAttention.newestFirst(logs).slice(0, HISTORY_PER_ORDER)
              .map((l) => ({ status: l.status, note: l.note, by: l.changed_by, at: l.created_at })),
          });
        });
        return json(headers, 200, { orders: shaped, logsError, weather: weatherState() });
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
      return json(headers, 200, { drivers: drivers.map((d) => ({ id: d.id, name: orderAdmin.driverName(d), vehicle_class: d.vehicle_class || "2wd", online: d.online === true, beach_permit_ok: d.beach_permit_ok === true })) });
    }

    return json(headers, 404, { error: "Not found" });
  } catch (err) {
    return serverError(headers, err, "Admin request failed", "admin");
  }
};

exports._internal = { routeParts, buildApplicationPatch, shapeApplication, toBool };
