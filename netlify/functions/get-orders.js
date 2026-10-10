/**
 * Netlify Function: Get Orders
 *
 * GET  /api/get-orders?...   — requires Bearer JWT (admin or customer tracking token)
 * POST /api/get-orders       — { order_number, phone } mints a customer tracking JWT
 *                              after verifying both match the order (track page login).
 *
 * Admin JWT: full list/filter (analytics).
 * Customer JWT: only the order_id embedded in the token.
 */

const { createClient } = require("@supabase/supabase-js");
const { headers: corsHeaders } = require("./_cors");
const {
  requireAdminOrCustomer,
  issueTrackingToken,
  jsonError,
} = require("./_auth");

function supabaseClient() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
}

const ORDER_SELECT = `
  *,
  customer:customers(first_name, last_name, phone, email),
  order_items(*),
  status_logs:order_status_logs(*)
`;

async function mintTrackingToken(event, headers) {
  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch (e) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "Invalid JSON" }) };
  }
  const orderNumber = (body.order_number || "").trim();
  const phone = (body.phone || "").trim();
  if (!orderNumber || !phone) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: "order_number and phone are required" }),
    };
  }
  if (!process.env.JWT_SECRET) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: "Auth not configured" }) };
  }

  const supabase = supabaseClient();
  const { data: order, error } = await supabase
    .from("orders")
    .select("id, order_number, customer:customers(phone)")
    .eq("order_number", orderNumber.toUpperCase())
    .maybeSingle();

  if (error || !order) {
    return { statusCode: 404, headers, body: JSON.stringify({ error: "Order not found" }) };
  }
  const custPhone = order.customer && order.customer.phone;
  if (!custPhone || String(custPhone).trim() !== phone) {
    // Same message as not-found to avoid phone enumeration of order numbers.
    return { statusCode: 404, headers, body: JSON.stringify({ error: "Order not found" }) };
  }

  const token = issueTrackingToken(order);
  if (!token) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: "Auth not configured" }) };
  }
  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({
      success: true,
      token,
      orderId: order.id,
      orderNumber: order.order_number,
    }),
  };
}

async function fetchOrders(event, headers, auth) {
  const supabase = supabaseClient();
  const url = new URL(event.rawUrl || `http://localhost${event.path}${event.rawQuery ? "?" + event.rawQuery : ""}`);
  // Netlify may put query on event.queryStringParameters
  const qs = event.queryStringParameters || {};
  const phone = url.searchParams.get("phone") || qs.phone || null;
  const orderNumber = url.searchParams.get("order_number") || qs.order_number || null;
  const orderId = url.searchParams.get("id") || qs.id || null;

  let query = supabase.from("orders").select(ORDER_SELECT);

  if (auth.kind === "customer") {
    // Scoped: ignore client filters that would widen access.
    query = query.eq("id", auth.decoded.order_id).single();
  } else if (orderId) {
    query = query.eq("id", orderId).single();
  } else if (orderNumber) {
    query = query.eq("order_number", orderNumber.toUpperCase());
    if (phone) query = query.eq("customer.phone", phone);
  } else if (phone) {
    query = query.eq("customer.phone", phone).order("created_at", { ascending: false });
  } else if (auth.kind === "admin") {
    // Admin list-all (analytics)
    query = query.order("created_at", { ascending: false }).limit(500);
  } else {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: "Please provide phone, order_number, or id parameter" }),
    };
  }

  const { data, error } = await query;
  if (error) throw error;

  if (!data || (Array.isArray(data) && data.length === 0)) {
    return { statusCode: 404, headers, body: JSON.stringify({ error: "Order not found" }) };
  }

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({ success: true, data }),
  };
}

exports.handler = async (event) => {
  const headers = corsHeaders(event);

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers, body: "" };
  }

  if (event.httpMethod === "POST") {
    return mintTrackingToken(event, headers);
  }

  if (event.httpMethod !== "GET") {
    return { statusCode: 405, headers, body: JSON.stringify({ error: "Method not allowed" }) };
  }

  let auth;
  try {
    auth = requireAdminOrCustomer(event);
  } catch (err) {
    return jsonError(headers, err);
  }

  try {
    return await fetchOrders(event, headers, auth);
  } catch (err) {
    console.error("Error fetching orders:", err);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: "Failed to fetch orders", message: err.message }),
    };
  }
};
