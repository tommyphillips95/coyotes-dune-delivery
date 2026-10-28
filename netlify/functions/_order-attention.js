/**
 * What the admin dashboard needs to see about an order, from the order row
 * and its order_status_logs. The log notes are written by create-order
 * (Address check / 78418 answer), create-payment-intent (Stripe succeeded but
 * order not marked paid), payment-webhook (paid / failed / refunds / second
 * payment WARNING) and dispatch (no driver). Matching is on those exact texts;
 * tests/admin-order-attention.test.js pins them to the writers.
 */
"use strict";

const LEVELS = { danger: 3, warn: 2, info: 1 };

function newestFirst(logs) {
  return (logs || []).slice().sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")));
}

function payment(order, logs) {
  const s = String((order && order.payment_status) || "").toLowerCase();
  const partial = (logs || []).find((l) => l && l.status === "partial_refund");
  if (s === "paid") return partial ? { cls: "partial", label: "Paid, partly refunded" } : { cls: "paid", label: "Paid" };
  if (s === "refunded") return { cls: "refunded", label: "Refunded" };
  if (s === "failed") return { cls: "failed", label: "Payment failed" };
  // payment_status defaults to 'pending' (schema.sql), so "pending" alone does
  // not mean a card payment was started: only a Stripe PaymentIntent does.
  if (s === "pending") return order.stripe_payment_intent_id
    ? { cls: "pending", label: "Card payment started, not paid" }
    : { cls: "none", label: "No card payment yet" };
  if (!s) return { cls: "none", label: "No card payment yet" };
  return { cls: "other", label: s.replace(/_/g, " ") };
}

/** [{ level, code, text }] newest problems first; empty = nothing to do. */
function attention(order, logsIn) {
  const logs = newestFirst(logsIn);
  const out = [];
  const add = (level, code, text) => { if (!out.some((a) => a.code === code)) out.push({ level, code, text }); };
  const pay = String((order && order.payment_status) || "").toLowerCase();
  const status = String((order && order.status) || "pending").toLowerCase();
  const closed = status === "completed" || status === "cancelled";

  for (const l of logs) {
    const note = String((l && l.note) || "");
    if (/succeeded but the order was not marked paid/.test(note) && pay !== "paid") {
      add("danger", "stripe_paid_not_marked", "Stripe took the payment but this order isn't marked paid. Check the payment webhook in Stripe/Netlify before charging again.");
    }
    if (/WARNING: paid after the order was cancelled/.test(note) && pay === "paid") {
      add("danger", "paid_after_close", "Paid after the order was cancelled, so no driver was sent. Refund this payment in Stripe.");
    }
    if (/WARNING: .*check Stripe for a second payment/.test(note)) {
      add("danger", "second_payment", "Possible second payment for this order. Check Stripe and refund the extra one.");
    }
    if (l.status === "partial_refund" && pay === "paid") {
      const m = /Partial refund: (\$[\d.,]+) of (\$[\d.,]+)/.exec(note);
      add("info", "partial_refund", m ? `Partly refunded: ${m[1]} of ${m[2]}.` : "Partly refunded.");
    }
    const addr = /Address check: (.*)$/.exec(note);
    if (addr && !closed) add("warn", "address_check", "Address check: " + addr[1].trim());
    const isle = /(Customer picked [^.]*?said it is on [^;.]+)[;.]/.exec(note) || /(Customer said the [^.]*Flour Bluff[^.]*)\./.exec(note);
    if (isle) add("info", "zip_area", isle[1] + ".");
  }
  if (pay === "failed" && !closed) {
    const f = logs.find((l) => /^Payment failed: /.test(String(l.note || "")));
    add("warn", "payment_failed", f ? f.note : "Card payment failed.");
  }
  // Latest dispatch word wins: "no driver" only counts if nothing happened after it.
  const latest = logs[0];
  const noDriver = latest && /^No online (\S+) driver available/.exec(String(latest.note || ""));
  if (noDriver && !closed && status !== "assigned" && status !== "in_progress") {
    add("warn", "no_driver", `No online ${noDriver[1]} driver was available. The order is waiting for dispatch.`);
  }
  if (order && order.weather_hold) add("info", "weather_hold", "On weather hold.");
  return out.sort((a, b) => LEVELS[b.level] - LEVELS[a.level]);
}

module.exports = { attention, payment, newestFirst, LEVELS };
