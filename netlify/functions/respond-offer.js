/** POST /api/respond-offer { offer_id, driver_id, action } */
const { createClient } = require("@supabase/supabase-js");
const { headers: corsHeaders } = require("./_cors");
const { offerNext, sendSMS, logSMS } = require("./dispatch");
exports.handler = async (event) => {
  const headers = corsHeaders(event);
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers, body: "" };
  if (event.httpMethod !== "POST") return { statusCode: 405, headers, body: JSON.stringify({ error: "Method not allowed" }) };
  try {
    const body = JSON.parse(event.body || "{}");
    const offerId = body.offer_id;
    const driverId = body.driver_id;
    const action = (body.action || "").toLowerCase();
    if (!offerId || !driverId || !["accept", "decline"].includes(action)) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: "offer_id, driver_id, action=accept|decline required" }) };
    }
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
    const { data: offer, error } = await supabase.from("dispatch_offers").select("*").eq("id", offerId).maybeSingle();
    if (error) throw error;
    if (!offer) return { statusCode: 404, headers, body: JSON.stringify({ error: "offer not found" }) };
    if (offer.driver_id !== driverId) return { statusCode: 403, headers, body: JSON.stringify({ error: "offer belongs to another driver" }) };
    if (offer.status !== "offered") return { statusCode: 409, headers, body: JSON.stringify({ error: "offer already " + offer.status }) };
    if (new Date(offer.expires_at).getTime() < Date.now()) {
      await supabase.from("dispatch_offers").update({ status: "expired", responded_at: new Date().toISOString() }).eq("id", offerId);
      const next = await offerNext(supabase, offer.order_id);
      return { statusCode: 409, headers, body: JSON.stringify({ error: "offer expired", next }) };
    }
    const now = new Date().toISOString();
    if (action === "decline") {
      await supabase.from("dispatch_offers").update({ status: "declined", responded_at: now }).eq("id", offerId);
      const next = await offerNext(supabase, offer.order_id);
      return { statusCode: 200, headers, body: JSON.stringify({ success: true, action: "declined", next }) };
    }
    const { data: order } = await supabase.from("orders").select("id, order_number, customer_id, driver_id, status").eq("id", offer.order_id).maybeSingle();
    if (order && order.driver_id) {
      await supabase.from("dispatch_offers").update({ status: "expired", responded_at: now }).eq("id", offerId);
      return { statusCode: 409, headers, body: JSON.stringify({ error: "order already assigned" }) };
    }
    await supabase.from("dispatch_offers").update({ status: "accepted", responded_at: now }).eq("id", offerId);
    await supabase.from("orders").update({ driver_id: driverId, status: "assigned", assigned_at: now }).eq("id", offer.order_id);
    await supabase.from("order_status_logs").insert([{ order_id: offer.order_id, status: "assigned", note: "Driver accepted auto-offer", changed_by: driverId }]);
    const { data: customer } = await supabase.from("customers").select("phone").eq("id", order.customer_id).maybeSingle();
    const { data: driver } = await supabase.from("applications").select("first_name, last_name").eq("id", driverId).maybeSingle();
    const name = driver ? (driver.first_name + " " + driver.last_name).trim() : "Your driver";
    const site = process.env.SITE_ORIGIN || "https://coyotes-dune-delivery.netlify.app";
    if (customer && customer.phone) {
      const msg = name + " accepted " + order.order_number + ". Track: " + site + "/track/ — Coyote's Dune Delivery";
      const sent = await sendSMS(customer.phone, msg);
      await logSMS(supabase, { order_id: offer.order_id, phone_number: customer.phone, message: msg, status: sent.success ? "sent" : "failed", twilio_sid: sent.messageSid || null, error: sent.error || null });
    }
    return { statusCode: 200, headers, body: JSON.stringify({ success: true, action: "accepted", orderId: offer.order_id }) };
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
