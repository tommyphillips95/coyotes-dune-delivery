/** Shared auto-offer: paid order → nearest eligible online driver → timeout → next. */

const { requiredClass, isBeachCity } = require("./zones");

const OFFER_SECONDS = 90;
const BEACH_CLASSES = new Set(["4x4", "utv", "awd"]);

function haversineMi(aLat, aLng, bLat, bLng) {
  const R = 3958.8;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
}

async function sendSMS(to, body) {
  if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN || !process.env.TWILIO_PHONE_NUMBER) {
    return { success: false, error: "twilio_not_configured" };
  }
  try {
    const twilio = require("twilio")(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
    const msg = await twilio.messages.create({
      body,
      from: process.env.TWILIO_PHONE_NUMBER,
      to,
    });
    return { success: true, messageSid: msg.sid };
  } catch (err) {
    console.error("dispatch SMS error", err);
    return { success: false, error: err.message };
  }
}

async function logSMS(supabase, row) {
  try {
    await supabase.from("sms_logs").insert([row]);
  } catch (e) {
    console.error("sms log failed", e);
  }
}

async function expireStale(supabase) {
  const now = new Date().toISOString();
  const { data: stale } = await supabase
    .from("dispatch_offers")
    .select("id, order_id")
    .eq("status", "offered")
    .lt("expires_at", now);
  if (!stale || !stale.length) return [];
  await supabase
    .from("dispatch_offers")
    .update({ status: "expired", responded_at: now })
    .eq("status", "offered")
    .lt("expires_at", now);
  return stale;
}

function classOk(need, have) {
  const h = (have || "2wd").toLowerCase();
  if (need === "4x4") return BEACH_CLASSES.has(h);
  return true;
}

async function offerNext(supabase, orderId) {
  await expireStale(supabase);

  const { data: order, error: orderErr } = await supabase
    .from("orders")
    .select("id, order_number, pickup_city, dropoff_city, pickup_lat, pickup_lng, pickup_address, dropoff_address, status, payment_status, customer_id, driver_id")
    .eq("id", orderId)
    .maybeSingle();
  if (orderErr) throw orderErr;
  if (!order) return { offered: false, reason: "order_missing" };
  if (order.driver_id) return { offered: false, reason: "already_assigned" };
  if (order.status === "cancelled" || order.status === "completed") {
    return { offered: false, reason: "order_closed" };
  }

  const need = requiredClass(order.pickup_city, order.dropoff_city || order.pickup_city);

  const { data: open } = await supabase
    .from("dispatch_offers")
    .select("id")
    .eq("order_id", orderId)
    .eq("status", "offered")
    .limit(1);
  if (open && open.length) return { offered: false, reason: "offer_open", offerId: open[0].id };

  const { data: already } = await supabase
    .from("dispatch_offers")
    .select("driver_id")
    .eq("order_id", orderId);
  const skip = new Set((already || []).map((r) => r.driver_id));

  const { data: drivers, error: drvErr } = await supabase
    .from("applications")
    .select("id, first_name, last_name, phone, vehicle_class, online, status")
    .eq("status", "approved")
    .eq("online", true);
  if (drvErr) throw drvErr;

  const pool = (drivers || []).filter((d) => !skip.has(d.id) && classOk(need, d.vehicle_class));
  if (!pool.length) {
    await supabase.from("order_status_logs").insert([{
      order_id: orderId,
      status: order.status,
      note: "No online " + need + " driver available. Holding for dispatch.",
      changed_by: "dispatch",
    }]);
    return { offered: false, reason: "no_drivers", requiredClass: need };
  }

  const ids = pool.map((d) => d.id);
  const { data: locs } = await supabase
    .from("driver_locations")
    .select("driver_id, lat, lng, timestamp")
    .in("driver_id", ids)
    .order("timestamp", { ascending: false });

  const last = {};
  (locs || []).forEach((row) => {
    if (!last[row.driver_id]) last[row.driver_id] = row;
  });

  const destLat = parseFloat(order.pickup_lat);
  const destLng = parseFloat(order.pickup_lng);
  const hub = {
    "Port Aransas": [27.8339, -97.0611],
    "Mustang Island": [27.74, -97.13],
    "Padre Island": [27.5772, -97.2736],
    "Corpus Christi": [27.8006, -97.3964],
    Rockport: [28.0206, -97.0544],
  };
  const fallback = hub[order.pickup_city] || [27.8339, -97.0611];
  const tLat = Number.isFinite(destLat) ? destLat : fallback[0];
  const tLng = Number.isFinite(destLng) ? destLng : fallback[1];

  pool.forEach((d) => {
    const loc = last[d.id];
    d._mi = loc ? haversineMi(parseFloat(loc.lat), parseFloat(loc.lng), tLat, tLng) : 999;
  });
  pool.sort((a, b) => a._mi - b._mi);
  const pick = pool[0];

  const expires = new Date(Date.now() + OFFER_SECONDS * 1000).toISOString();
  const { data: offer, error: offerErr } = await supabase
    .from("dispatch_offers")
    .insert([{
      order_id: orderId,
      driver_id: pick.id,
      status: "offered",
      required_class: need,
      distance_mi: Math.round(pick._mi * 10) / 10,
      expires_at: expires,
    }])
    .select()
    .single();
  if (offerErr) throw offerErr;

  const site = process.env.SITE_ORIGIN || "https://coyotes-dune-delivery.netlify.app";
  const sms = "Coyote offer " + order.order_number + ": " + order.pickup_city + " → " + (order.dropoff_city || order.pickup_city) + ". " + need.toUpperCase() + " run. " + OFFER_SECONDS + "s to accept: " + site + "/driver/?offer=" + offer.id;
  if (pick.phone) {
    const sent = await sendSMS(pick.phone, sms);
    await logSMS(supabase, {
      order_id: orderId,
      phone_number: pick.phone,
      message: sms,
      status: sent.success ? "sent" : "failed",
      twilio_sid: sent.messageSid || null,
      error: sent.error || null,
    });
  }

  await supabase.from("order_status_logs").insert([{
    order_id: orderId,
    status: order.status,
    note: "Offered to " + (pick.first_name || "driver") + " (" + need + ", ~" + offer.distance_mi + " mi).",
    changed_by: "dispatch",
  }]);

  return {
    offered: true,
    offerId: offer.id,
    driverId: pick.id,
    requiredClass: need,
    distanceMi: offer.distance_mi,
    expiresAt: expires,
    beach: isBeachCity(order.pickup_city) || isBeachCity(order.dropoff_city),
  };
}

module.exports = { OFFER_SECONDS, offerNext, expireStale, sendSMS, logSMS, haversineMi };
