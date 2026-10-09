/**
 * Customer tracking — polls /api/get-orders + /api/get-driver-location every 15s.
 * Leaflet/OSM by default so launch works without a Maps billing key.
 */
(function () {
  "use strict";
  const API_BASE = "/api";
  const POLL_INTERVAL_MS = 15000;
  let map = null, driverMarker = null, pickupMarker = null, dropoffMarker = null;
  let pollTimer = null, currentOrder = null, currentDriverId = null;
  const lookupForm = document.getElementById("lookupForm");
  const lookupBtn = document.getElementById("lookupBtn");
  const mapEl = document.getElementById("map");
  const mapLoading = document.getElementById("mapLoading");
  const mapError = document.getElementById("mapError");
  window.initMap = function () {};
  function formatStatus(status) {
    return ({ pending: "Pending", assigned: "Assigned", in_progress: "On the Way", completed: "Completed", cancelled: "Cancelled" })[status] || status;
  }
  function formatServiceType(type) {
    return ({ ride: "On-Demand Ride", package_delivery: "Package Delivery", grocery_run: "Grocery Run", group_transport: "Group Transport" })[type] || type;
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
      map = L.map(mapEl).setView(center, 13);
      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "&copy; OpenStreetMap" }).addTo(map);
    }
    if (pickupMarker) { map.removeLayer(pickupMarker); pickupMarker = null; }
    if (dropoffMarker) { map.removeLayer(dropoffMarker); dropoffMarker = null; }
    if (order.pickup_lat && order.pickup_lng) pickupMarker = L.marker([parseFloat(order.pickup_lat), parseFloat(order.pickup_lng)]).addTo(map).bindPopup("Pickup");
    if (order.dropoff_lat && order.dropoff_lng) dropoffMarker = L.marker([parseFloat(order.dropoff_lat), parseFloat(order.dropoff_lng)]).addTo(map).bindPopup("Dropoff");
    fitLeaflet();
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
    if (currentOrder && currentOrder.dropoff_lat && currentOrder.dropoff_lng) {
      const R = 3958.8, toRad = function (d) { return (d * Math.PI) / 180; };
      const dLat = toRad(parseFloat(currentOrder.dropoff_lat) - la);
      const dLng = toRad(parseFloat(currentOrder.dropoff_lng) - ln);
      const s = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(toRad(la)) * Math.cos(toRad(parseFloat(currentOrder.dropoff_lat))) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
      const miles = 2 * R * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
      const minutes = Math.max(1, Math.round((miles / 22) * 60));
      const etaValue = document.getElementById("etaValue");
      const etaUnit = document.getElementById("etaUnit");
      if (etaValue) etaValue.textContent = String(minutes);
      if (etaUnit) etaUnit.textContent = minutes === 1 ? "minute" : "minutes";
    }
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
    });
  }
  async function fetchDriverLocation(driverId, orderId) {
    try {
      const params = new URLSearchParams();
      if (driverId) params.set("driver_id", driverId);
      else if (orderId) params.set("order_id", orderId);
      else return;
      const res = await fetch(API_BASE + "/get-driver-location?" + params.toString(),
        currentToken ? { headers: { Authorization: "Bearer " + currentToken } } : undefined);
      const json = await res.json();
      if (json.success && json.data && json.data.location) {
        updateDriverMarker(json.data.location.lat, json.data.location.lng);
        if (json.data.driver) {
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

  async function mintToken(orderNumber, phone) {
    const res = await fetch(API_BASE + "/get-orders", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ order_number: orderNumber, phone: phone }),
    });
    const json = await res.json().catch(function () { return {}; });
    if (!res.ok || !json.token) return null;
    if (C) C.saveTrackingToken(json.orderNumber || orderNumber, json.token);
    return json.token;
  }

  // Returns { order } | { expired: true } | { error }
  async function fetchOrder(token) {
    const res = await fetch(API_BASE + "/get-orders", { headers: { Authorization: "Bearer " + token } });
    if (res.status === 401 || res.status === 403) return { expired: true };
    const json = await res.json().catch(function () { return {}; });
    if (!res.ok) return { error: json.error || "Lookup failed" };
    const payload = json.data || json;
    const rows = Array.isArray(payload) ? payload : payload ? [payload] : [];
    return rows[0] ? { order: rows[0] } : { error: "Order not found" };
  }

  function renderOrder(order) {
    currentOrder = order;
    currentDriverId = order.driver_id || null;
    showCard("etaCard"); showCard("driverCard"); showCard("orderCard"); showCard("timelineCard");
    document.getElementById("detailOrderNum").textContent = order.order_number;
    document.getElementById("detailService").textContent = formatServiceType(order.service_type);
    document.getElementById("detailPickup").textContent = order.pickup_address || "--";
    document.getElementById("detailDropoff").textContent = order.dropoff_address || "--";
    document.getElementById("detailStatus").textContent = formatStatus(order.status);
    updateTimeline(order);
  }

  function isTerminal(status) {
    return C ? C.isTerminalStatus(status) : (status === "completed" || status === "cancelled");
  }

  async function tick() {
    if (polling || !currentToken) return; // never overlap requests
    polling = true;
    try {
      const r = await fetchOrder(currentToken);
      if (r.expired) {
        stopPolling();
        if (C && currentOrder) C.clearTrackingToken(currentOrder.order_number);
        currentToken = null;
        alert("Your tracking session expired. Enter your order number and phone to keep tracking.");
        return;
      }
      if (r.order) {
        renderOrder(r.order);
        if (isTerminal(r.order.status)) { stopPolling(); return; }
      }
      await fetchDriverLocation(currentDriverId, currentOrder && currentOrder.id);
    } catch (err) {
      console.error(err); // keep polling; transient network errors are common on the beach
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
    if (!r.order) return { error: r.error };
    renderOrder(r.order);
    readyMap(r.order);
    await fetchDriverLocation(currentDriverId, r.order.id);
    if (!isTerminal(r.order.status)) startPolling(); else stopPolling();
    return { ok: true };
  }

  async function lookupOrder(orderNumber, phone) {
    lookupBtn.disabled = true;
    lookupBtn.textContent = "Tracking...";
    try {
      orderNumber = (orderNumber || "").toUpperCase();
      let token = C ? C.getTrackingToken(orderNumber) : null;
      if (!token) {
        if (!orderNumber || !phone) { alert("Please enter both order number and phone number."); return; }
        token = await mintToken(orderNumber, phone);
      }
      if (!token) { alert("Order not found. Please check your order number and phone number."); return; }
      let r = await trackWithToken(token);
      if (r.expired && phone) {
        if (C) C.clearTrackingToken(orderNumber);
        token = await mintToken(orderNumber, phone);
        r = token ? await trackWithToken(token) : { error: "Order not found" };
      }
      if (r.expired) {
        if (C) C.clearTrackingToken(orderNumber);
        alert("Your tracking link expired. Enter your phone number to continue.");
      } else if (!r.ok) {
        alert("Order not found. Please check your order number and phone number.");
      }
    } catch (err) {
      console.error(err);
      alert("Something went wrong. Please try again.");
    } finally {
      lookupBtn.disabled = false;
      lookupBtn.textContent = "Track Order";
    }
  }

  lookupForm.addEventListener("submit", function (e) {
    e.preventDefault();
    lookupOrder(document.getElementById("lookupOrderNum").value.trim(), document.getElementById("lookupPhone").value.trim());
  });

  // Deep link from the order confirmation: /track/?order=CDD-...
  (function autoTrack() {
    const params = C ? C.parseOrderParams(window.location.search) : {};
    if (!params.track) return;
    document.getElementById("lookupOrderNum").value = params.track;
    if (C && C.getTrackingToken(params.track)) lookupOrder(params.track, "");
  })();

  window.addEventListener("beforeunload", stopPolling);
})();
