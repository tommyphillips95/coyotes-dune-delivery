/**
 * Customer text when a dispatcher assigns a driver (called from
 * _order-admin.changeOrder, so PUT /api/admin/orders/:id and the older
 * PATCH /api/update-order both send it, once).
 *
 *   "Your driver Dana has been assigned to order CDD-…. Track: SITE/track/?order=CDD-… — Coyote's Dune Delivery"
 *
 * - Link from _site-url.trackUrl: no token (the track page asks for the
 *   order's phone number).
 * - Driver first name only, and only if we have one. Never the driver's phone.
 * - Twilio not configured: nothing sent; logged in sms_logs as
 *   failed / twilio_not_configured (same as the driver text).
 * - No duplicate: skipped if this order's customer already got a sent text
 *   with this track link naming the same first name (or, with no name, any
 *   assignment text), including the auto-offer "… accepted …" text.
 * - Opt-out: there is no opt-out table; Twilio blocks numbers that replied
 *   STOP and returns error 21610. If an earlier send to this number failed
 *   that way, we don't try again.
 * - Never throws: the assignment is already saved when this runs.
 */
"use strict";

const { sendSMS, logSMS } = require("./dispatch");
const { trackUrl } = require("./_site-url");

const OPTED_OUT = /21610|unsubscribed/i;

function firstName(d) {
  const s = String((d && d.first_name) || "").replace(/[^\p{L}\p{M}' .-]/gu, "").trim().split(/\s+/)[0] || "";
  return s.slice(0, 30);
}

function assignedText(orderNumber, driver) {
  const name = firstName(driver);
  return (name ? `Your driver ${name} has been assigned to order ${orderNumber}.` : `A driver has been assigned to order ${orderNumber}.`)
    + ` Track: ${trackUrl(orderNumber)} — Coyote's Dune Delivery`;
}

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

/** Resolves { sent, reason, message? }. */
async function notifyCustomerAssigned(supabase, order, driver) {
  try {
    if (!order || !order.customer_id) return { sent: false, reason: "no_customer" };
    const { data: customer, error: cErr } = await supabase.from("customers").select("phone").eq("id", order.customer_id).maybeSingle();
    if (cErr) throw cErr;
    const phone = customer && customer.phone ? String(customer.phone).trim() : "";
    if (phone.replace(/\D/g, "").length < 10) return { sent: false, reason: "no_phone" };

    const message = assignedText(order.order_number, driver);
    const { data: prior, error: pErr } = await supabase.from("sms_logs").select("phone_number, message, status, error").eq("order_id", order.id);
    if (pErr) throw pErr;
    const { data: stops } = await supabase.from("sms_logs").select("error").eq("phone_number", phone).eq("status", "failed");
    if ((stops || []).some((r) => OPTED_OUT.test(String(r.error || "")))) {
      console.log(`[assign-sms] ${order.order_number}: customer opted out (Twilio 21610); not texting`);
      return { sent: false, reason: "opted_out" };
    }
    const link = trackUrl(order.order_number);
    const name = firstName(driver);
    const already = (prior || []).some((r) => r.status === "sent" && r.phone_number === phone && String(r.message || "").includes(link)
      && (!name || new RegExp("(^|[^\\p{L}])" + escapeRe(name) + "([^\\p{L}]|$)", "u").test(String(r.message))));
    if (already) return { sent: false, reason: "already_sent" };

    const res = await sendSMS(phone, message);
    await logSMS(supabase, { order_id: order.id, phone_number: phone, message, status: res.success ? "sent" : "failed", twilio_sid: res.messageSid || null, error: res.error || null });
    if (!res.success) console.log(`[assign-sms] ${order.order_number}: customer text not sent (${res.error})`);
    return res.success ? { sent: true, reason: null, message } : { sent: false, reason: res.error || "failed" };
  } catch (e) {
    console.error("[assign-sms] customer text failed; assignment kept:", (e && e.message) || e);
    return { sent: false, reason: "error" };
  }
}

module.exports = { notifyCustomerAssigned, assignedText, firstName, OPTED_OUT };
