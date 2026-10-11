/**
 * POST /api/update-driver-location
 * Body: { lat, lng, order_id?, accuracy?, online? }
 * driver_id comes from the driver JWT (admin may pass driver_id).
 */

const { createClient } = require("@supabase/supabase-js");
const { headers: corsHeaders } = require("./_cors");
const { requireAdminOrDriver, jsonError } = require("./_auth");

exports.handler = async (event) => {
  const headers = corsHeaders(event);

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers, body: "" };
  }

  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers, body: JSON.stringify({ error: "Method not allowed" }) };
  }

  try {
    const auth = requireAdminOrDriver(event);
    const body = JSON.parse(event.body || "{}");
    const driverId = auth.kind === "admin" ? body.driver_id : auth.decoded.driver_id;
    if (!driverId) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: "driver_id is required" }) };
    }
    if (auth.kind === "driver" && body.driver_id && body.driver_id !== auth.decoded.driver_id) {
      return { statusCode: 403, headers, body: JSON.stringify({ error: "Forbidden" }) };
    }

    if (body.lat === undefined || body.lng === undefined) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: "lat and lng are required" }) };
    }

    const lat = parseFloat(body.lat);
    const lng = parseFloat(body.lng);

    if (isNaN(lat) || isNaN(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: "Invalid latitude or longitude values" }) };
    }

    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

    const locationData = {
      driver_id: driverId,
      lat: lat,
      lng: lng,
      order_id: body.order_id || null,
      accuracy: body.accuracy ? parseFloat(body.accuracy) : null,
      timestamp: new Date().toISOString(),
    };

    const { data, error } = await supabase.from("driver_locations").insert([locationData]).select().single();
    if (error) throw error;

    const online = body.online !== false;
    await supabase.from("applications").update({ online }).eq("id", driverId);

    return {
      statusCode: 201,
      headers,
      body: JSON.stringify({
        success: true,
        data: {
          id: data.id,
          driver_id: data.driver_id,
          lat: data.lat,
          lng: data.lng,
          order_id: data.order_id,
          accuracy: data.accuracy,
          timestamp: data.timestamp,
        },
      }),
    };
  } catch (err) {
    if (err.status) return jsonError(headers, err);
    console.error("Error updating driver location:", err);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: "Failed to update driver location", message: err.message }),
    };
  }
};
