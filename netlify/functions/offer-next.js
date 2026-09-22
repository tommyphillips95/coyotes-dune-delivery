/** POST /api/offer-next  { order_id } */
const { createClient } = require("@supabase/supabase-js");
const { headers: corsHeaders } = require("./_cors");
const { offerNext } = require("./dispatch");
exports.handler = async (event) => {
  const headers = corsHeaders(event);
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers, body: "" };
  if (event.httpMethod !== "POST") return { statusCode: 405, headers, body: JSON.stringify({ error: "Method not allowed" }) };
  try {
    const body = JSON.parse(event.body || "{}");
    if (!body.order_id) return { statusCode: 400, headers, body: JSON.stringify({ error: "order_id required" }) };
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
    const result = await offerNext(supabase, body.order_id);
    return { statusCode: 200, headers, body: JSON.stringify({ success: true, ...result }) };
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
