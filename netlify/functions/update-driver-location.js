/**
 * POST /api/update-driver-location
 * Body: { lat, lng, order_id?, accuracy?, online? } — or { online } alone for a GPS-less heartbeat
 * driver_id comes from the driver JWT (admin may pass driver_id).
 */

const { createClient } = require("@supabase/supabase-js");
const { serverError } = require("./_errors");
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

    const hasCoords = body.lat !== undefined && body.lng !== undefined;
    const onlineOnly = body.online !== undefined && !hasCoords;

    // Offline-tolerant heartbeat: drivers can stay online when GPS briefly fails.
    if (!hasCoords && !onlineOnly) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: "lat and lng are required (or send online for a heartbeat)" }) };
    }

    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
    const now = new Date().toISOString();
    const online = body.online !== false;

    if (onlineOnly) {
      await supabase.from("applications").update({ online, last_location_at: now }).eq("id", driverId);
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          success: true,
          heartbeat: true,
          data: { driver_id: driverId, online, timestamp: now },
        }),
      };
    }

    const lat = parseFloat(body.lat);
    const lng = parseFloat(body.lng);

    if (isNaN(lat) || isNaN(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: "Invalid latitude or longitude values" }) };
    }

    // The driver app doesn't send order_id, but /track/ looks fixes up by
    // order. Stamp the driver's active (assigned / in_progress) order so the
    // customer sees them. A failed lookup never blocks the location post.
    let orderId = body.order_id || null;
    if (!orderId) {
      try {
        const { data: active, error: activeErr } = await supabase
          .from("orders")
          .select("id, assigned_at")
          .eq("driver_id", driverId)
          .in("status", ["assigned", "in_progress"])
          .order("assigned_at", { ascending: false })
          .limit(1);
        if (activeErr) throw activeErr;
        if (active && active[0]) orderId = active[0].id;
      } catch (e) {
        console.error("[update-driver-location] active order lookup:", e);
      }
    }

    const locationData = {
      driver_id: driverId,
      lat: lat,
      lng: lng,
      order_id: orderId,
      accuracy: body.accuracy ? parseFloat(body.accuracy) : null,
      timestamp: now,
    };

    const { data, error } = await supabase.from("driver_locations").insert([locationData]).select().single();
    if (error) throw error;

    await supabase.from("applications").update({ online, last_location_at: now }).eq("id", driverId);

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
    return serverError(headers, err, "Failed to update driver location", "update-driver-location");
  }
};
