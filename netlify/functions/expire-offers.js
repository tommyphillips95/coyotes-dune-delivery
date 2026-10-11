/** Scheduled every minute + manual GET/POST /api/expire-offers (admin or internal) */
const { createClient } = require("@supabase/supabase-js");
const { headers: corsHeaders } = require("./_cors");
const { expireStale, offerNext } = require("./dispatch");
const { requireAdminOrInternal, jsonError } = require("./_auth");

exports.config = { schedule: "*/1 * * * *" };
exports.handler = async (event) => {
  const headers = corsHeaders(event || {});
  try {
    requireAdminOrInternal(event || {});
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
    const stale = await expireStale(supabase);
    const nexts = [];
    const seen = new Set();
    for (const row of stale) {
      if (seen.has(row.order_id)) continue;
      seen.add(row.order_id);
      nexts.push(await offerNext(supabase, row.order_id));
    }
    return { statusCode: 200, headers, body: JSON.stringify({ success: true, expired: stale.length, nexts }) };
  } catch (err) {
    if (err.status) return jsonError(headers, err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
