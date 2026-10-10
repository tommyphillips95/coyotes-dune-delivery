/** Scheduled every minute + manual GET/POST /api/expire-offers */
const { createClient } = require("@supabase/supabase-js");
const { headers: corsHeaders } = require("./_cors");
const { expireStale, offerNext } = require("./dispatch");
exports.config = { schedule: "*/1 * * * *" };
exports.handler = async (event) => {
  const headers = corsHeaders(event || {});
  try {
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
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
