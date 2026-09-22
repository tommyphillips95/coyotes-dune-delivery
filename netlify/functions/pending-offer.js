/** GET /api/pending-offer?driver_id= */
const { createClient } = require("@supabase/supabase-js");
const { headers: corsHeaders } = require("./_cors");
const { expireStale } = require("./dispatch");
exports.handler = async (event) => {
  const headers = corsHeaders(event);
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers, body: "" };
  if (event.httpMethod !== "GET") return { statusCode: 405, headers, body: JSON.stringify({ error: "Method not allowed" }) };
  try {
    const driverId = (event.queryStringParameters || {}).driver_id;
    if (!driverId) return { statusCode: 400, headers, body: JSON.stringify({ error: "driver_id required" }) };
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
    await expireStale(supabase);
    const { data, error } = await supabase.from("dispatch_offers").select("id, order_id, status, required_class, distance_mi, expires_at, orders(order_number, pickup_city, dropoff_city, pickup_address, dropoff_address, service_type, estimated_price)").eq("driver_id", driverId).eq("status", "offered").order("created_at", { ascending: false }).limit(1);
    if (error) throw error;
    return { statusCode: 200, headers, body: JSON.stringify({ success: true, offer: data && data[0] ? data[0] : null }) };
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
