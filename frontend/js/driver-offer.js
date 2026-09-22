/* Incoming auto-offer card. Loaded after driver.js.
   Polls /api/pending-offer and posts /api/respond-offer. 90s countdown. */
(function () {
  const POLL_MS = 4000;
  let pollTimer = null;
  let tickTimer = null;
  let current = null;

  function session() {
    try { return JSON.parse(localStorage.getItem("driver_session") || "null"); }
    catch (e) { return null; }
  }

  function driverId() {
    const s = session();
    return s && s.applicantId ? s.applicantId : null;
  }

  function toast(msg, type) {
    if (typeof window.showToast === "function") return window.showToast(msg, type);
    const box = document.getElementById("toast-container");
    if (!box) return;
    const el = document.createElement("div");
    el.className = "toast " + (type || "success");
    el.textContent = msg;
    box.appendChild(el);
    setTimeout(function () { el.remove(); }, 4000);
  }

  function hideCard() {
    const card = document.getElementById("offer-card");
    if (card) card.classList.add("hidden");
    current = null;
    if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
  }

  function render(offer) {
    const card = document.getElementById("offer-card");
    if (!card) return;
    current = offer;
    card.classList.remove("hidden");
    const order = offer.orders || {};
    const route = document.getElementById("offer-route");
    const meta = document.getElementById("offer-meta");
    if (route) route.textContent = (order.pickup_city || "Pickup") + " \u2192 " + (order.dropoff_city || order.pickup_city || "Dropoff");
    if (meta) {
      const bits = [
        order.order_number,
        offer.required_class ? String(offer.required_class).toUpperCase() : null,
        offer.distance_mi != null ? offer.distance_mi + " mi" : null,
        order.estimated_price != null ? "$" + Number(order.estimated_price).toFixed(2) : null
      ].filter(Boolean);
      meta.textContent = bits.join(" \u00b7 ");
    }
    tick();
    if (!tickTimer) tickTimer = setInterval(tick, 1000);
  }

  function tick() {
    const el = document.getElementById("offer-timer");
    if (!el || !current || !current.expires_at) return;
    const left = Math.max(0, Math.round((new Date(current.expires_at).getTime() - Date.now()) / 1000));
    el.textContent = left + "s";
    if (left <= 0) poll();
  }

  async function poll() {
    const id = driverId();
    if (!id) return;
    try {
      const res = await fetch("/api/pending-offer?" + new URLSearchParams({ driver_id: id }));
      const data = await res.json().catch(function () { return {}; });
      if (!res.ok || !data.offer) { hideCard(); return; }
      render(data.offer);
    } catch (err) {
      console.error("pending-offer poll failed", err);
    }
  }

  async function respond(action) {
    const id = driverId();
    if (!current || !id) return;
    const acceptBtn = document.getElementById("offer-accept");
    const declineBtn = document.getElementById("offer-decline");
    if (acceptBtn) acceptBtn.disabled = true;
    if (declineBtn) declineBtn.disabled = true;
    try {
      const res = await fetch("/api/respond-offer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ offer_id: current.id, driver_id: id, action: action })
      });
      const data = await res.json().catch(function () { return {}; });
      if (!res.ok) throw new Error(data.error || data.message || "respond failed");
      toast(action === "accept" ? "Offer accepted. Head to pickup." : "Offer declined.", "success");
      hideCard();
    } catch (err) {
      toast(err.message || "Could not respond to offer", "error");
    } finally {
      if (acceptBtn) acceptBtn.disabled = false;
      if (declineBtn) declineBtn.disabled = false;
    }
  }

  function start() {
    if (pollTimer) return;
    poll();
    pollTimer = setInterval(poll, POLL_MS);
  }

  document.addEventListener("DOMContentLoaded", function () {
    const acceptBtn = document.getElementById("offer-accept");
    const declineBtn = document.getElementById("offer-decline");
    if (acceptBtn) acceptBtn.addEventListener("click", function () { respond("accept"); });
    if (declineBtn) declineBtn.addEventListener("click", function () { respond("decline"); });
    start();
  });
})();
