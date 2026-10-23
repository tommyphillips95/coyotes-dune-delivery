/**
 * Customer tracking — polls /api/get-orders + /api/get-driver-location every 15s.
 * Leaflet/OSM by default so launch works without a Maps billing key.
 */
(function () {
  "use strict";
  const API_BASE = "/api";
  const POLL_INTERVAL_MS = 15000;
  let map = null, driverMarker = null, pickupMarker = null, dropoffMarker = null;
  let pollTimer = null, currentOrder = null, currentDriverId = null, driverInfoShown = false;
  const lookupForm = document.getElementById("lookupForm");
  const lookupBtn = document.getElementById("lookupBtn");
  const mapEl = document.getElementById("map");
  const mapLoading = document.getElementById("mapLoading");
  const mapError = document.getElementById("mapError");
  window.initMap = function () {};
  function formatStatus(status) {
    const C = window.CoyoteCoastal;
    if (C && C.statusLabel) return C.statusLabel(status);
    return ({ pending: "Pending", assigned: "Assigned", in_progress: "On the Way", completed: "Completed", cancelled: "Cancelled" })[status] || String(status || "").replace(/_/g, " ");
  }
  function formatServiceType(type) {
    return ({ ride: "On-Demand Ride", package_delivery: "Package Delivery", grocery_run: "Grocery Run", group_transport: "Group Transport" })[type] || type;
  }
  // Inline, announced messages instead of alert() pop-ups.
  function say(text) {
    const box = document.getElementById("lookupMessage");
    if (!box) { if (text) alert(text); return; }
    box.textContent = text || "";
    box.hidden = !text;
  }
  function showCard(id) { const el = document.getElementById(id); if (el) el.classList.remove("hidden"); }
  function defaultCenter(order) {
    if (order && order.pickup_lat && order.pickup_lng) return [parseFloat(order.pickup_lat), parseFloat(order.pickup_lng)];
    return [27.8339, -97.0611];
  }
  function readyMap(order) {
    mapLoading.classList.add("hidden");
    mapError.classList.add("hidden");
    mapEl.classList.remove("hidden");
    const center = defaultCenter(order);
    if (typeof L === "undefined") { mapError.classList.remove("hidden"); return; }
    if (!map) {
      // On touch screens one finger scrolls the page (no scroll trap); two fingers
      // pinch-zoom and move the map. Desktop keeps Leaflet's defaults.
      const touch = isTouchScreen();
      map = L.map(mapEl, touch ? { dragging: false, tap: false, scrollWheelZoom: false } : {}).setView(center, 13);
      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "&copy; OpenStreetMap" }).addTo(map);
      const hint = document.getElementById("mapHint");
      if (touch && hint) {
        hint.classList.remove("hidden");
        mapEl.addEventListener("touchstart", function (e) { if (e.touches && e.touches.length > 1) hint.classList.add("hidden"); }, { passive: true });
      }
      watchMapSize();
    }
    map.invalidateSize();
    if (pickupMarker) { map.removeLayer(pickupMarker); pickupMarker = null; }
    if (dropoffMarker) { map.removeLayer(dropoffMarker); dropoffMarker = null; }
    if (order.pickup_lat && order.pickup_lng) pickupMarker = L.marker([parseFloat(order.pickup_lat), parseFloat(order.pickup_lng)], { alt: "Pickup location", title: "Pickup" }).addTo(map).bindPopup("Pickup");
    if (order.dropoff_lat && order.dropoff_lng) dropoffMarker = L.marker([parseFloat(order.dropoff_lat), parseFloat(order.dropoff_lng)], { alt: "Dropoff location", title: "Dropoff" }).addTo(map).bindPopup("Dropoff");
    fitLeaflet();
  }
  function isTouchScreen() {
    try { if (window.matchMedia && window.matchMedia("(pointer: coarse)").matches) return true; } catch (e) {}
    return typeof L !== "undefined" && !!(L.Browser && L.Browser.mobile);
  }
  // Keep Leaflet's tile grid in sync when the box changes size (rotation, cards
  // appearing above it, the hidden->visible switch).
  let sizeTimer = null;
  function resizeMapSoon() {
    if (!map) return;
    clearTimeout(sizeTimer);
    sizeTimer = setTimeout(function () { map.invalidateSize(); }, 150); // no refit: keep the user's zoom
  }
  function watchMapSize() {
    if (typeof ResizeObserver !== "undefined") new ResizeObserver(resizeMapSoon).observe(mapEl);
    window.addEventListener("resize", resizeMapSoon);
    window.addEventListener("orientationchange", resizeMapSoon);
  }
  function fitLeaflet() {
    if (!map || typeof L === "undefined") return;
    const pts = [];
    if (pickupMarker) pts.push(pickupMarker.getLatLng());
    if (dropoffMarker) pts.push(dropoffMarker.getLatLng());
    if (driverMarker) pts.push(driverMarker.getLatLng());
    if (pts.length) map.fitBounds(L.latLngBounds(pts).pad(0.2));
  }
  function updateDriverMarker(lat, lng) {
    const la = parseFloat(lat), ln = parseFloat(lng);
    if (!map || Number.isNaN(la) || Number.isNaN(ln)) return;
    if (driverMarker) driverMarker.setLatLng([la, ln]);
    else driverMarker = L.circleMarker([la, ln], { radius: 10, color: "#1A2F4B", fillColor: "#4C8C64", fillOpacity: 1 }).addTo(map).bindPopup("Driver");
    fitLeaflet();
    renderEta();
  }
  // ETA follows the leg the driver is on: to the pickup until the trip starts
  // (pending/assigned), to the drop-off while in progress, and nothing once the
  // order is completed or cancelled. Straight-line miles at 22 mph.
  function etaTarget(order) {
    const st = order && order.status;
    const pt = (lat, lng) => (lat != null && lng != null && lat !== "" && lng !== "" && !Number.isNaN(parseFloat(lat)) && !Number.isNaN(parseFloat(lng)))
      ? { lat: parseFloat(lat), lng: parseFloat(lng) } : null;
    if (st === "pending" || st === "assigned") {
      const p = pt(order.pickup_lat, order.pickup_lng);
      return p ? Object.assign(p, { label: "Driver arrives at pickup in" }) : null;
    }
    if (st === "in_progress") {
      const d = pt(order.dropoff_lat, order.dropoff_lng);
      return d ? Object.assign(d, { label: "Arrival at drop-off in" }) : null;
    }
    return null;
  }
  function etaMinutes(from, to) {
    const R = 3958.8, toRad = function (d) { return (d * Math.PI) / 180; };
    const dLat = toRad(to.lat - from.lat);
    const dLng = toRad(to.lng - from.lng);
    const s = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(toRad(from.lat)) * Math.cos(toRad(to.lat)) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
    const miles = 2 * R * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
    return Math.max(1, Math.round((miles / 22) * 60));
  }
  function renderEta() {
    const etaLabel = document.getElementById("etaLabel");
    const etaValue = document.getElementById("etaValue");
    const etaUnit = document.getElementById("etaUnit");
    if (!etaValue || !etaUnit) return;
    const target = etaTarget(currentOrder);
    if (etaLabel) etaLabel.textContent = target ? target.label : "Estimated arrival";
    if (target && driverMarker) {
      const here = driverMarker.getLatLng();
      const minutes = etaMinutes({ lat: here.lat, lng: here.lng }, target);
      etaValue.textContent = String(minutes);
      etaUnit.textContent = minutes === 1 ? "minute" : "minutes";
    } else {
      etaValue.textContent = "--";
      etaUnit.textContent = target ? "Shown once your driver shares their location" : "";
    }
  }
  function clearDriverDot() {
    if (driverMarker && map) map.removeLayer(driverMarker);
    driverMarker = null;
  }
  // No driver on the order (never assigned, or dispatch unassigned them): an
  // old GPS ping for this order must not show as "your driver".
  function hasNoDriver(order) {
    return !!order && !order.driver_id && order.status === "pending";
  }
  // Completed / cancelled: no live card, no driver dot, no GPS driver details.
  function showFinished() {
    const eta = document.getElementById("etaCard");
    if (eta) eta.classList.add("hidden");
    clearDriverDot();
  }

  function updateTimeline(order) {
    const statuses = ["pending", "assigned", "in_progress", "completed"];
    const currentIndex = statuses.indexOf(order.status);
    statuses.forEach(function (s, i) {
      const camel = s === "in_progress" ? "InProgress" : s.charAt(0).toUpperCase() + s.slice(1);
      const dot = document.getElementById("dot" + camel);
      if (!dot) return;
      dot.classList.toggle("completed", i < currentIndex);
      dot.classList.toggle("active", i === currentIndex);
      // The dots are colour-only; tell assistive tech which step is current.
      const step = dot.parentElement;
      if (step) {
        if (i === currentIndex) step.setAttribute("aria-current", "step");
        else step.removeAttribute("aria-current");
      }
    });
  }
  async function fetchDriverLocation(driverId, orderId) {
    try {
      const params = new URLSearchParams();
      if (driverId) params.set("driver_id", driverId);
      else if (orderId) params.set("order_id", orderId);
      else return;
      // No driver on the order yet: there is no location to fetch (the server
      // would answer 404 every 15s). Ask again once get-orders shows a driver.
      if (!driverId && currentOrder && !currentOrder.driver_id) return;
      const res = await timedFetch(API_BASE + "/get-driver-location?" + params.toString(),
        currentToken ? { headers: { Authorization: "Bearer " + currentToken } } : undefined);
      // 404 = no location yet; 5xx/429 = try next tick. Either way the body
      // is not a location, so don't read it, and don't log every 15s.
      if (!res || !res.ok) return;
      let json;
      try { json = await res.json(); } catch (_) { return; } // HTML error page, proxy page, empty body
      if (!json || typeof json !== "object") return;
      if (currentOrder && (isTerminal(currentOrder.status) || hasNoDriver(currentOrder))) return; // no live dot
      if (json.success && json.data && json.data.location) {
        updateDriverMarker(json.data.location.lat, json.data.location.lng);
        if (json.data.driver) {
          driverInfoShown = true;
          const d = json.data.driver;
          document.getElementById("driverName").textContent = ((d.first_name || "") + " " + (d.last_name || "")).trim() || "Your Driver";
          document.getElementById("driverVehicle").textContent = d.vehicle_make && d.vehicle_model ? ((d.vehicle_color || "") + " " + d.vehicle_make + " " + d.vehicle_model).trim() : "Vehicle info unavailable";
        }
      }
    } catch (err) { console.error(err); }
  }
  // ── Order loading (customer tracking JWT; see netlify/functions/get-orders.js) ──
  let currentToken = null;
  let polling = false;
  const C = window.CoyoteCoastal || null;

  // Every request has a timeout so a stalled connection ends in a message
  // (lookup) or a counted failure (polling) instead of "Tracking..." forever.
  function timedFetch(url, init) {
    const ms = C && C.requestTimeoutMs ? C.requestTimeoutMs() : 15000;
    return C && C.timedFetch ? C.timedFetch(fetch, url, init, ms) : fetch(url, init);
  }
  // 5xx / 429 mean "try again", not "no such order".
  function isTemporary(status) { return status >= 500 || status === 429; }

  // Returns a token string, null (not found / wrong phone) or { unavailable: true }.
  async function mintToken(orderNumber, phone) {
    const res = await timedFetch(API_BASE + "/get-orders", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ order_number: orderNumber, phone: phone }),
    });
    if (isTemporary(res.status)) return { unavailable: true };
    const json = await res.json().catch(function () { return null; });
    if (res.ok && !json) return { unavailable: true }; // 200 but not our JSON (proxy page)
    if (!res.ok || !json || !json.token) return null;
    if (C) C.saveTrackingToken(json.orderNumber || orderNumber, json.token);
    return json.token;
  }

  // Returns { order } | { expired: true } | { error }
  async function fetchOrder(token) {
    const res = await timedFetch(API_BASE + "/get-orders", { headers: { Authorization: "Bearer " + token } });
    if (res.status === 401 || res.status === 403) return { expired: true };
    if (isTemporary(res.status)) return { unavailable: true };
    const json = await res.json().catch(function () { return {}; });
    if (!res.ok) return { error: json.error || "Lookup failed" };
    const payload = json.data || json;
    const rows = Array.isArray(payload) ? payload : payload ? [payload] : [];
    return rows[0] ? { order: rows[0] } : { error: "Order not found" };
  }

  let announcedStatus = null;
  // Polling updates the status silently; announce changes (not the first
  // render, which the user just asked for) using the existing label.
  function announceStatus(order) {
    const prev = announcedStatus;
    announcedStatus = order.order_number + "|" + order.status;
    const live = document.getElementById("trackStatusLive");
    if (!live || prev === null || prev === announcedStatus) return;
    if (prev.split("|")[0] !== order.order_number) return;
    live.textContent = "Status: " + formatStatus(order.status);
  }
  function renderOrder(order) {
    announceStatus(order);
    currentOrder = order;
    currentDriverId = order.driver_id || null;
    showCard("driverCard"); showCard("orderCard"); showCard("timelineCard");
    if (isTerminal(order.status)) showFinished(); else showCard("etaCard");
    if (hasNoDriver(order)) clearDriverDot();
    document.getElementById("detailOrderNum").textContent = order.order_number;
    document.getElementById("detailService").textContent = formatServiceType(order.service_type);
    document.getElementById("detailPickup").textContent = order.pickup_address || "--";
    document.getElementById("detailDropoff").textContent = order.dropoff_address || "--";
    document.getElementById("detailStatus").textContent = formatStatus(order.status);
    // Payment row: only once the card payment actually went through
    // (payment_status from get-orders); otherwise the row stays hidden.
    const payRow = document.getElementById("detailPaymentRow");
    if (payRow) {
      const b = C && C.paymentBadge ? C.paymentBadge(order) : null;
      const paid = !!b && b.cls === "paid";
      payRow.hidden = !paid;
      document.getElementById("detailPayment").textContent = paid ? b.label : "";
    }
    // Until the driver shares GPS, say what we know instead of a stale default
    // ("Not assigned yet" next to Status: Assigned) or a bare "--".
    // Dispatch can also unassign or cancel from the admin dashboard, so the
    // card follows the order rather than sticking on the last GPS driver.
    if (!order.driver_id && order.status === "pending") driverInfoShown = false;
    const t = driverCardText(order);
    if (!driverInfoShown || t.final) {
      document.getElementById("driverName").textContent = t.name;
      document.getElementById("driverVehicle").textContent = t.detail;
    }
    renderEta();
    updateTimeline(order);
  }

  function driverCardText(order) {
    if (order.status === "cancelled") return { name: "Order cancelled", detail: "No driver is coming for this order.", final: true };
    if (order.status === "completed") return { name: "Trip completed", detail: "", final: true };
    if (order.status === "in_progress") return { name: "Driver on the way", detail: "Details appear once your driver shares their location." };
    const hasDriver = !!order.driver_id || order.status === "assigned" || order.status === "in_progress";
    return hasDriver
      ? { name: "Driver assigned", detail: "Details appear when your driver is on the way." }
      : { name: "Not assigned yet", detail: "We'll show your driver here once one accepts." };
  }

  function isTerminal(status) {
    return C ? C.isTerminalStatus(status) : (status === "completed" || status === "cancelled");
  }

  // ── Refresh failures: back off and say so ──
  // After FAIL_NOTICE_AFTER failed refreshes in a row (network error, 5xx or
  // 429) a "Connection lost, retrying…" notice is shown once (announced by
  // its role="status"). Retries back off 15s → 30s → 60s → 120s (the interval
  // still fires every 15s; ticks before the next attempt are skipped). The
  // first good refresh clears the notice and the backoff.
  const FAIL_NOTICE_AFTER = 3;
  const MAX_BACKOFF_MS = 120000;
  let failures = 0, nextAttemptAt = 0;
  function now() { return Date.now(); }
  function setConnectionNotice(on) {
    const box = document.getElementById("connectionNotice");
    if (!box) return;
    const text = on ? "Connection lost, retrying…" : "";
    if (box.textContent !== text) box.textContent = text; // unchanged text is not re-announced
    box.hidden = !on;
  }
  function refreshFailed() {
    failures++;
    nextAttemptAt = now() + Math.min(POLL_INTERVAL_MS * Math.pow(2, failures - 1), MAX_BACKOFF_MS) - 1000;
    if (failures >= FAIL_NOTICE_AFTER) setConnectionNotice(true);
  }
  function refreshOk() {
    failures = 0; nextAttemptAt = 0;
    setConnectionNotice(false);
  }

  async function tick() {
    if (polling || !currentToken) return; // never overlap requests
    if (failures && now() < nextAttemptAt) return; // backing off
    polling = true;
    try {
      const r = await fetchOrder(currentToken);
      if (r.unavailable) { refreshFailed(); return; }
      if (r.expired) {
        stopPolling();
        setConnectionNotice(false);
        if (C && currentOrder) C.clearTrackingToken(currentOrder.order_number);
        currentToken = null;
        say("Your tracking session expired. Enter your order number and phone to keep tracking.");
        return;
      }
      if (r.order) {
        refreshOk();
        renderOrder(r.order);
        if (isTerminal(r.order.status)) { stopPolling(); return; }
      }
      await fetchDriverLocation(currentDriverId, currentOrder && currentOrder.id);
    } catch (err) {
      console.error(err); // keep polling; transient network errors are common on the beach
      refreshFailed();
    } finally {
      polling = false;
    }
  }

  function startPolling() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(tick, POLL_INTERVAL_MS);
  }
  function stopPolling() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }

  async function trackWithToken(token) {
    currentToken = token;
    const r = await fetchOrder(token);
    if (r.expired) return { expired: true };
    if (r.unavailable) return { unavailable: true };
    if (!r.order) return { error: r.error };
    renderOrder(r.order);
    readyMap(r.order);
    if (!isTerminal(r.order.status)) await fetchDriverLocation(currentDriverId, r.order.id);
    if (!isTerminal(r.order.status)) startPolling(); else stopPolling();
    return { ok: true };
  }

  async function lookupOrder(orderNumber, phone) {
    // Only a user-started lookup (focus in the form) gets focus back; the
    // automatic lookup from a tracking link must not move focus on load.
    const userStarted = !!document.activeElement && document.activeElement !== document.body;
    lookupBtn.disabled = true;
    lookupBtn.textContent = "Tracking...";
    say("");
    try {
      orderNumber = (orderNumber || "").toUpperCase();
      let token = C ? C.getTrackingToken(orderNumber) : null;
      if (!token) {
        if (!orderNumber || !phone) { say("Enter both your order number and the phone number used for the order."); (orderNumber ? document.getElementById("lookupPhone") : document.getElementById("lookupOrderNum")).focus(); return; }
        token = await mintToken(orderNumber, phone);
      }
      const UNAVAILABLE = "We couldn't look up your order right now. Your order is not affected. Please try again in a minute.";
      if (token && token.unavailable) { say(UNAVAILABLE); return; }
      if (!token) { say("We couldn't find that order. Check the order number and phone number."); return; }
      let r = await trackWithToken(token);
      if (r.expired && phone) {
        if (C) C.clearTrackingToken(orderNumber);
        token = await mintToken(orderNumber, phone);
        r = token && token.unavailable ? token : token ? await trackWithToken(token) : { error: "Order not found" };
      }
      if (r.unavailable) {
        say(UNAVAILABLE);
      } else if (r.expired) {
        if (C) C.clearTrackingToken(orderNumber);
        say("Your tracking link expired. Enter your phone number to continue.");
        document.getElementById("lookupPhone").focus();
      } else if (!r.ok) {
        say("We couldn't find that order. Check the order number and phone number.");
      }
    } catch (err) {
      console.error(err);
      say("We couldn't look up your order right now. Check your signal and try again.");
    } finally {
      lookupBtn.disabled = false;
      lookupBtn.textContent = "Track Order";
      // Disabling the button while looking up drops keyboard focus to <body>.
      if (userStarted && (!document.activeElement || document.activeElement === document.body)) lookupBtn.focus();
    }
  }

  lookupForm.addEventListener("submit", function (e) {
    e.preventDefault();
    lookupOrder(document.getElementById("lookupOrderNum").value.trim(), document.getElementById("lookupPhone").value.trim());
  });

  // Deep link from the order confirmation: /track/?order=CDD-...
  (function autoTrack() {
    const params = C ? C.parseOrderParams(window.location.search) : {};
    if (!params.track) {
      // ?order= was there but isn't an order number (cut-off or edited link).
      if (/[?&](order|track)=[^&]/.test(window.location.search || "")) {
        say("That tracking link isn't complete. Enter your order number and phone number.");
      }
      return;
    }
    document.getElementById("lookupOrderNum").value = params.track;
    if (C && C.getTrackingToken(params.track)) { lookupOrder(params.track, ""); return; }
    // No saved token on this device (other browser, cleared storage): the
    // phone is the only thing missing, so put the cursor there and say so.
    const phone = document.getElementById("lookupPhone");
    if (phone && phone.focus) phone.focus();
    say("Enter the phone number used for this order to start tracking.");
  })();

  window.addEventListener("beforeunload", stopPolling);
})();
