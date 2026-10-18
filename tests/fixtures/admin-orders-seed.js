// Orders + status logs as the functions from #53-#65 write them (note text
// copied from create-order, create-payment-intent, payment-webhook, dispatch).
// Test data only: no real customers.
"use strict";
const t = (h) => `2026-10-18T${String(h).padStart(2, "0")}:00:00.000Z`;
const o = (id, n, extra) => Object.assign({ id, order_number: n, status: "pending", payment_status: null, pickup_city: "Port Aransas", dropoff_city: "Mustang Island",
  required_vehicle_class: "4x4", weather_hold: false, estimated_price: 35, created_at: t(10) }, extra);
const log = (order_id, h, status, note, changed_by) => ({ id: `${order_id}-${h}-${status}`, order_id, status, note, changed_by: changed_by || "system", created_at: t(h) });

module.exports = () => ({
  applications: [
    { id: "a-1", first_name: "Sam", last_name: "Test", email: "sam@example.com", status: "pending", created_at: "2026-10-01" },
    { id: "a-2", first_name: "Jo", last_name: "Test", email: "jo@example.com", status: "background_check", created_at: "2026-10-02" },
  ],
  orders: [
    o("o-ok", "CDD-OK1", { status: "completed", payment_status: "paid", final_price: 35, created_at: t(9) }),
    o("o-partial", "CDD-PART1", { status: "completed", payment_status: "paid", final_price: 35, created_at: t(11) }),
    o("o-stripe", "CDD-STRIPE1", { payment_status: "pending", stripe_payment_intent_id: "pi_test_1", created_at: t(12) }),
    o("o-failed", "CDD-FAIL1", { payment_status: "failed", stripe_payment_intent_id: "pi_test_2", created_at: t(13) }),
    o("o-addr", "CDD-ADDR1", { pickup_city: "Rockport", dropoff_city: "Rockport", required_vehicle_class: "2wd", estimated_price: 20, created_at: t(14) }),
    o("o-island", "CDD-ISLE1", { pickup_city: "Padre Island", dropoff_city: "Corpus Christi", estimated_price: 75, created_at: t(15) }),
    o("o-nodriver", "CDD-NODRV1", { payment_status: "paid", created_at: t(16) }),
    o("o-refund", "CDD-REF1", { status: "cancelled", payment_status: "refunded", created_at: t(8) }),
    o("o-second", "CDD-TWICE1", { payment_status: "paid", stripe_payment_intent_id: "pi_test_4", created_at: t(17) }),
    o("o-processing", "CDD-PROC1", { payment_status: "pending", stripe_payment_intent_id: "pi_test_5", status: null, created_at: t(18) }),
  ],
  order_status_logs: [
    log("o-ok", 9, "pending", "Order received. 4 mi. Required class 4x4."),
    log("o-ok", 10, "paid", "Payment succeeded via Stripe. Amount: $35.00", "stripe_webhook"),
    log("o-partial", 11, "paid", "Payment succeeded via Stripe. Amount: $35.00", "stripe_webhook"),
    log("o-partial", 13, "partial_refund", "Partial refund: $10.00 of $35.00 refunded so far [refund:ch_test_1:1000]", "stripe_webhook"),
    log("o-stripe", 12, "pending", "PaymentIntent created: pi_test_1"),
    log("o-stripe", 13, "paid", "Stripe reports pi_test_1 succeeded but the order was not marked paid; no new charge was made. Check the payment webhook."),
    log("o-failed", 13, "failed", "Payment failed: Your card was declined.", "stripe_webhook"),
    log("o-addr", 14, "pending", "Order received. 10 mi. Required class 2wd. Address check: pickup ZIP 78358 isn't mapped to Rockport; please confirm the address."),
    log("o-island", 15, "pending", "Order received. 22 mi. Required class 4x4. Customer picked Corpus Christi, pickup ZIP 78418, and said it is on Padre Island; priced and dispatched as Padre Island."),
    log("o-nodriver", 16, "pending", "Order received. 4 mi. Required class 4x4."),
    log("o-nodriver", 17, "pending", "No online 4x4 driver available. Holding for dispatch.", "dispatch"),
    log("o-refund", 9, "refunded", "Refund issued: $35.00 of $35.00 (full) [refund:ch_test_3:3500]", "stripe_webhook"),
    log("o-second", 17, "paid", "Payment succeeded via Stripe. Amount: $35.00 (WARNING: pi_test_9 is not the order's current PaymentIntent pi_test_4; check Stripe for a second payment)", "stripe_webhook"),
    log("o-processing", 18, "pending", "PaymentIntent created: pi_test_5"),
  ],
});
