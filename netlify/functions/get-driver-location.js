const { createClient } = require("@supabase/supabase-js");
const { headers: corsHeaders } = require("./_cors");

exports.handler = async (event) => {
  const headers = corsHeaders(event);
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers, body: "" };
  if (event.httpMethod !== "GET") return { statusCode: 405, headers, body: JSON.stringify({ error: "Method not allowed" }) };

  try {
    const url = new URL(event.rawUrl || ("http://localhost" + event.path + (event.rawQuery ? "?" + event.rawQuery : "")));
    const qs = event.queryStringParameters || {};
    const driverId = url.searchParams.get("driver_id") || qs.driver_id;
    const orderId = url.searchParams.get("order_id") || qs.order_id;
    if (!driverId && !orderId) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: "Please provide driver_id or order_id parameter" }) };
    }

    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
    let query = supabase.from("driver_locations").select("*");
    if (driverId) query = query.eq("driver_id", driverId);
    else query = query.eq("order_id", orderId);
    query = query.order("timestamp", { ascending: false }).limit(1);
    const { data, error } = await query;
    if (error) throw error;
    if (!data || data.length === 0) {
      return { statusCode: 404, headers, body: JSON.stringify({ success: false, error: "No location found for this driver/order" }) };
    }

    const location = data[0];
    let driverInfo = null;
    if (location.driver_id) {
      const { data: driverData, error: driverError } = await supabase
        .from("applications")
        .select("first_name, last_name, vehicle_make, vehicle_model, vehicle_color")
        .eq("id", location.driver_id)
        .maybeSingle();
      if (!driverError && driverData) driverInfo = driverData;
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
        data: {
          location: {
            id: location.id,
            driver_id: location.driver_id,
            lat: location.lat,
            lng: location.lng,
            order_id: location.order_id,
            accuracy: location.accuracy,
            timestamp: location.timestamp,
          },
          driver: driverInfo,
        },
      }),
    };
  } catch (err) {
    console.error("Error fetching driver location:", err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: "Failed to fetch driver location", message: err.message }) };
  }
};
