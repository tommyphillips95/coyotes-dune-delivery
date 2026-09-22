/**
 * Netlify Function: Create Customer Order (with SMS notifications)
 * POST /api/create-order
 */

const { createClient } = require("@supabase/supabase-js");
const { headers: corsHeaders } = require("./ _cors".replace(" ", ""));
const { milesBetween, isBeachCity, requiredClass } = require("./zones");

function generateOrderNumber() {
  const prefix = "CDD";
  const timestamp = Date.now().toString(36).toUpperCase();
  const random = Math.random().toString(36).substring(2, 5).toUpperCase();
  return `${prefix}-${timestamp}-${random}`;
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

    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

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

    const priceMap = {
      ride: { base: 12, per_mile: 2.5 },
      package_delivery: { base: 15, per_mile: 2.0 },
      grocery_run: { base: 18, per_mile: 1.5 },
      group_transport: { base: 35, per_mile: 3.0 },
    };
    const pricing = priceMap[body.service_type] || priceMap.ride;
    const pickupCity = body.pickup_city.trim();
    const dropoffCity = (body.dropoff_city || body.pickup_city).trim();
    const miles = milesBetween(pickupCity, dropoffCity);
    let estimatedPrice = pricing.base + miles * pricing.per_mile;
    if (isBeachCity(pickupCity) || isBeachCity(dropoffCity)) estimatedPrice += 8;
    if (body.passenger_count && body.passenger_count > 1) estimatedPrice += (body.passenger_count - 1) * 3;
    if (body.package_size === "large") estimatedPrice += 8;
    if (body.package_size === "oversized") estimatedPrice += 15;
    estimatedPrice = Math.round(estimatedPrice * 100) / 100;
    const vehicle = requiredClass(pickupCity, dropoffCity);

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
    };

    const { data: order, error: orderError } = await supabase.from("orders").insert([orderData]).select().single();
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
      }),
    };
  } catch (err) {
    console.error("Error creating order:", err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: "Failed to create order", message: err.message }) };
  }
};
