/* Incoming auto-offer card. Polls /api/pending-offer, posts /api/respond-offer.
   Injects the 90s Accept/Decline card if the portal HTML does not have it. */
(function () {
  const POLL_MS = 4000;
  let pollTimer = null;
  let tickTimer = null;
  let current = null;

  function ensureCard() {
    if (document.getElementById("offer-card")) return;
    if (!document.getElementById("offer-style")) {
      const style = document.createElement("style");
      style.id = "offer-style";
      style.textContent = ".offer-card{background:#fff;border:2px solid #C9A87C;border-radius:14px;padding:20px;margin-bottom:20px}.offer-card.hidden{display:none}.offer-card-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:10px}.offer-timer{font-variant-numeric:tabular-nums;font-weight:700;color:#C45A3E}.offer-route{font-weight:600;margin:0 0 6px}.offer-meta{font-size:.88rem;color:#6B6B6B;margin:0 0 14px}.offer-actions{display:grid;grid-template-columns:1fr 1fr;gap:10px}.offer-actions .btn{padding:12px;border:none;border-radius:8px;font-weight:600;cursor:pointer}.offer-actions .btn-primary{background:#4C8C64;color:#fff}.offer-actions .btn-danger{background:#C45A3E;color:#fff}";
      document.head.appendChild(style);
    }
    const card = document.createElement("section");
    card.id = "offer-card";
    card.className = "offer-card hidden";
    card.innerHTML = "<div class=\"offer-card-header\"><h3>Incoming offer</h3><span class=\"offer-timer\" id=\"offer-timer\">90s</span></div><p class=\"offer-route\" id=\"offer-route\">\u2014</p><p class=\"offer-meta\" id=\"offer-meta\"></p><div class=\"offer-actions\"><button type=\"button\" id=\"offer-accept\" class=\"btn btn-primary\">Accept</button><button type=\"button\" id=\"offer-decline\" class=\"btn btn-danger\">Decline</button></div><p class=\"gps-note\" id=\"offer-status\">90 second window. Next nearest driver if you pass.</p>";
    const host = document.getElementById("approved-content") || document.querySelector(".portal-main") || document.body;
    const gps = document.getElementById("gps-card");
    if (gps && gps.parentNode) gps.parentNode.insertBefore(card, gps.nextSibling);
    else host.insertBefore(card, host.firstChild);
  }

  function session() {
    try { return JSON.parse(localStorage.getItem("driver_session") || "null"); }
    catch (e) { return null; }
  }

  function driverId() {
    const s = session();
    return s && s.applicantId ? s.applicantId : null;
  }

  function toast(msg, type) {
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
    ensureCard();
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

  function bind() {
    ensureCard();
    const acceptBtn = document.getElementById("offer-accept");
    const declineBtn = document.getElementById("offer-decline");
    if (acceptBtn) acceptBtn.addEventListener("click", function () { respond("accept"); });
    if (declineBtn) declineBtn.addEventListener("click", function () { respond("decline"); });
    if (!pollTimer) {
      poll();
      pollTimer = setInterval(poll, POLL_MS);
    }
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", bind);
  else bind();
})();
