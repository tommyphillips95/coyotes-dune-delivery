/**
 * Netlify Function: Create Customer Order (with SMS notifications)
 * POST /api/create-order
 */

const { createClient } = require("@supabase/supabase-js");
const { headers: corsHeaders } = require("./_cors");
const { priceQuote } = require("./zones");
const { issueTrackingToken } = require("./_auth");
const { weatherShutdownActive, weatherShutdownPayload } = require("./_weather");

function generateOrderNumber() {
  const prefix = "CDD";
  const timestamp = Date.now().toString(36).toUpperCase();
  const random = Math.random().toString(36).substring(2, 5).toUpperCase();
  return `${prefix}-${timestamp}-${random}`;
}

// ── Server-side input checks (the browser checks too, but is not trusted) ──
const ZIP_RE = /^\d{5}(-?\d{4})?$/; // 5-digit ZIP, optional +4 (matches the order form)
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/;
const SERVICE_TZ = "America/Chicago";

function isValidZip(zip) {
  return ZIP_RE.test(String(zip == null ? "" : zip).trim());
}

/** Wall-clock "YYYY-MM-DDTHH:MM" in America/Chicago for an instant. */
function chicagoWallClock(now) {
  const parts = {};
  new Intl.DateTimeFormat("en-CA", {
    timeZone: SERVICE_TZ, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(now || new Date()).forEach((p) => { parts[p.type] = p.value; });
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

/** Returns an error string for a bad scheduled date/time, or null if OK. */
function scheduleError(date, time, now) {
  const d = String(date || "").trim();
  const t = String(time || "").trim();
  if (!DATE_RE.test(d) || !TIME_RE.test(t)) return "Please choose a valid date and time.";
  const dt = new Date(d + "T00:00:00Z");
  if (Number.isNaN(dt.getTime()) || dt.toISOString().slice(0, 10) !== d) return "Please choose a valid date and time.";
  if (`${d}T${t.slice(0, 5)}` < chicagoWallClock(now)) return "That pickup time has already passed. Please choose a future time.";
  return null;
}

// ── Idempotency (one order per checkout attempt) ──
// The order form sends idempotency_key (a random UUID) and reuses it when the
// customer retries after a dropped connection. A repeat key returns the
// original order instead of creating a second one. Needs
// schema/order_idempotency.sql; until it is applied we log and create normally.
const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9_-]{16,100}$/;

function isMissingIdempotencyColumn(err) {
  if (!err) return false;
  const msg = String(err.message || "");
  return err.code === "42703" || err.code === "PGRST204" || (/idempotency_key/.test(msg) && /column/i.test(msg));
}

function isUniqueViolation(err) {
  return !!err && err.code === "23505";
}

const digits = (p) => String(p || "").replace(/\D/g, "");

/** { order } when the key was seen, { order: null } when not, { unsupported: true } before the migration. */
async function findOrderByIdempotencyKey(supabase, key) {
  const { data, error } = await supabase.from("orders").select("*").eq("idempotency_key", key).maybeSingle();
  if (error) {
    if (isMissingIdempotencyColumn(error)) {
      console.warn("[create-order] orders.idempotency_key missing; run schema/order_idempotency.sql");
      return { unsupported: true, order: null };
    }
    throw error;
  }
  return { order: data || null };
}

/** Same response shape as a fresh create, for a repeated key from the same customer. */
async function replayResponse(supabase, headers, order, phone) {
  const { data: customer, error } = await supabase.from("customers").select("id, phone").eq("id", order.customer_id).maybeSingle();
  if (error) throw error;
  if (!customer || digits(customer.phone) !== digits(phone)) {
    return { statusCode: 409, headers, body: JSON.stringify({ error: "This checkout was already used. Please refresh the page and try again." }) };
  }
  const priced = priceQuote(order.pickup_city, order.dropoff_city || order.pickup_city, {
    service_type: order.service_type,
    passenger_count: order.passenger_count,
    package_size: order.package_size,
  });
  const trackingToken = issueTrackingToken(order);
  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({
      success: true,
      replayed: true,
      orderId: order.id,
      orderNumber: order.order_number,
      estimatedPrice: order.estimated_price,
      miles: priced.miles,
      requiredClass: order.required_vehicle_class || priced.requiredClass,
      status: order.status,
      trackingToken: trackingToken || undefined,
    }),
  };
}

async function sendSMS({ to_phone, message_body }) {
  try {
    const twilio = require("twilio");
    const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
    const message = await client.messages.create({
      body: message_body,
      from: process.env.TWILIO_PHONE_NUMBER,
      to: to_phone,
    });
    return { success: true, messageSid: message.sid };
  } catch (err) {
    console.error("SMS send error:", err);
    return { success: false, error: err.message };
  }
}

async function logSMS(supabase, row) {
  try {
    await supabase.from("sms_logs").insert([row]);
  } catch (logErr) {
    console.error("Failed to log SMS:", logErr);
  }
}

exports.handler = async (event) => {
  const headers = corsHeaders(event);

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers, body: "" };
  }

  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers, body: JSON.stringify({ error: "Method not allowed" }) };
  }

  try {
    const body = JSON.parse(event.body || "{}");

    if (!body.first_name || !body.last_name || !body.phone) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: "First name, last name, and phone are required" }) };
    }
    if (!body.pickup_address || !body.pickup_city) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: "Pickup address and city are required" }) };
    }
    if (!body.service_type) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: "Service type is required" }) };
    }
    for (const [field, label] of [["pickup_zip", "pickup"], ["dropoff_zip", "dropoff"]]) {
      if (body[field] != null && String(body[field]).trim() !== "" && !isValidZip(body[field])) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: `Please enter a 5-digit ZIP code for ${label}.` }) };
      }
    }
    // Same condition the scheduling branch below uses; date without time still falls back to ASAP.
    if (body.schedule === "later" && body.scheduled_date && body.scheduled_time) {
      const bad = scheduleError(body.scheduled_date, body.scheduled_time);
      if (bad) return { statusCode: 400, headers, body: JSON.stringify({ error: bad }) };
    }

    let idempotencyKey = null;
    if (body.idempotency_key != null && body.idempotency_key !== "") {
      idempotencyKey = String(body.idempotency_key).trim();
      if (!IDEMPOTENCY_KEY_RE.test(idempotencyKey)) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: "Invalid idempotency_key" }) };
      }
    }

    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

    // A retry of a checkout that already created an order gets that order back
    // (even if a weather hold started in between). No new rows, no second SMS.
    let idempotencySupported = true;
    if (idempotencyKey) {
      const seen = await findOrderByIdempotencyKey(supabase, idempotencyKey);
      if (seen.unsupported) idempotencySupported = false;
      else if (seen.order) return await replayResponse(supabase, headers, seen.order, body.phone);
    }

    if (weatherShutdownActive()) {
      return {
        statusCode: 503,
        headers,
        body: JSON.stringify(weatherShutdownPayload()),
      };
    }

    let customerId;
    const { data: existingCustomer, error: customerLookupError } = await supabase
      .from("customers").select("id").eq("phone", body.phone.trim()).maybeSingle();
    if (customerLookupError) throw customerLookupError;

    if (existingCustomer) {
      customerId = existingCustomer.id;
    } else {
      const { data: newCustomer, error: customerError } = await supabase.from("customers").insert([{
        first_name: body.first_name.trim(),
        last_name: body.last_name.trim(),
        phone: body.phone.trim(),
        email: body.email ? body.email.trim() : null,
      }]).select().single();
      if (customerError) throw customerError;
      customerId = newCustomer.id;
    }

    const orderNumber = generateOrderNumber();
    let isAsap = true;
    let scheduledDate = null;
    let scheduledTime = null;
    if (body.schedule === "later" && body.scheduled_date && body.scheduled_time) {
      isAsap = false;
      scheduledDate = body.scheduled_date;
      scheduledTime = body.scheduled_time;
    }

    const pickupCity = body.pickup_city.trim();
    const dropoffCity = (body.dropoff_city || body.pickup_city).trim();
    const priced = priceQuote(pickupCity, dropoffCity, {
      service_type: body.service_type,
      passenger_count: body.passenger_count,
      package_size: body.package_size,
    });
    const miles = priced.miles;
    const estimatedPrice = priced.total;
    const vehicle = priced.requiredClass;

    const orderData = {
      order_number: orderNumber,
      customer_id: customerId,
      service_type: body.service_type,
      status: "pending",
      pickup_address: body.pickup_address.trim(),
      pickup_city: pickupCity,
      pickup_zip: body.pickup_zip ? body.pickup_zip.trim() : null,
      dropoff_address: body.dropoff_address ? body.dropoff_address.trim() : null,
      dropoff_city: body.dropoff_city ? body.dropoff_city.trim() : null,
      dropoff_zip: body.dropoff_zip ? body.dropoff_zip.trim() : null,
      scheduled_date: scheduledDate,
      scheduled_time: scheduledTime,
      is_asap: isAsap,
      passenger_count: body.passenger_count ? parseInt(body.passenger_count, 10) : 1,
      package_description: body.package_description ? body.package_description.trim() : null,
      package_size: body.package_size || null,
      special_instructions: body.special_instructions ? body.special_instructions.trim() : (vehicle === "4x4" ? "Beach access — 4x4 required." : null),
      estimated_price: estimatedPrice,
      final_price: null,
      tip_amount: body.tip_amount ? parseFloat(body.tip_amount) : 0,
      required_vehicle_class: vehicle,
      weather_hold: false,
    };

    if (idempotencyKey && idempotencySupported) orderData.idempotency_key = idempotencyKey;

    let { data: order, error: orderError } = await supabase.from("orders").insert([orderData]).select().single();
    if (orderError && orderData.idempotency_key && isMissingIdempotencyColumn(orderError)) {
      console.warn("[create-order] orders.idempotency_key missing on insert; creating without it");
      delete orderData.idempotency_key;
      ({ data: order, error: orderError } = await supabase.from("orders").insert([orderData]).select().single());
    }
    if (orderError && idempotencyKey && isUniqueViolation(orderError)) {
      // Two requests with the same key raced; the other one won. Return its order.
      const seen = await findOrderByIdempotencyKey(supabase, idempotencyKey);
      if (seen.order) return await replayResponse(supabase, headers, seen.order, body.phone);
    }
    if (orderError) throw orderError;

    await supabase.from("order_status_logs").insert([{
      order_id: order.id,
      status: "pending",
      note: "Order received. " + miles + " mi. Required class " + vehicle + ".",
      changed_by: "system",
    }]);

    const smsEnabled = !!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_PHONE_NUMBER);
    const customerPhone = body.phone.trim().replace(/\D/g, "");
    if (smsEnabled && customerPhone.length >= 10) {
      const smsMessage = "Your order " + order.order_number + " has been received. We'll assign a driver shortly. — Coyote's Dune Delivery";
      const smsResult = await sendSMS({ to_phone: customerPhone, message_body: smsMessage });
      await logSMS(supabase, {
        order_id: order.id,
        phone_number: customerPhone,
        message: smsMessage,
        status: smsResult.success ? "sent" : "failed",
        twilio_sid: smsResult.messageSid || null,
        error: smsResult.error || null,
      });
    }

    const trackingToken = issueTrackingToken(order);

    return {
      statusCode: 201,
      headers,
      body: JSON.stringify({
        success: true,
        orderId: order.id,
        orderNumber: order.order_number,
        estimatedPrice: order.estimated_price,
        miles: miles,
        requiredClass: vehicle,
        status: order.status,
        trackingToken: trackingToken || undefined,
      }),
    };
  } catch (err) {
    console.error("Error creating order:", err);
    // Details stay in the function log; the browser shows this message, so no DB/internal text.
    return { statusCode: 500, headers, body: JSON.stringify({ error: "Failed to create order", message: "We couldn't place your order. Please try again." }) };
  }
};

// Exposed for unit tests.
exports._validation = { isValidZip, chicagoWallClock, scheduleError, isMissingIdempotencyColumn, IDEMPOTENCY_KEY_RE };
