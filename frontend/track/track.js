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
      const res = await fetch(API_BASE + "/get-driver-location?" + params.toString());
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
  function startPolling() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(function () {
      fetchDriverLocation(currentDriverId, currentOrder && currentOrder.id);
    }, POLL_INTERVAL_MS);
  }
  function stopPolling() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }
  async function lookupOrder(orderNumber, phone) {
    lookupBtn.disabled = true;
    lookupBtn.textContent = "Tracking...";
    try {
      const params = new URLSearchParams();
      if (orderNumber) params.set("order_number", orderNumber);
      if (phone) params.set("phone", phone);
      const res = await fetch(API_BASE + "/get-orders?" + params.toString());
      const json = await res.json();
      const payload = json.data || json;
      const rows = Array.isArray(payload) ? payload : payload && payload.data ? payload.data : payload ? [payload] : [];
      const order = rows[0];
      if (!order) { alert("Order not found. Please check your order number and phone number."); return; }
      currentOrder = order;
      currentDriverId = order.driver_id || null;
      showCard("etaCard"); showCard("driverCard"); showCard("orderCard"); showCard("timelineCard");
      document.getElementById("detailOrderNum").textContent = order.order_number;
      document.getElementById("detailService").textContent = formatServiceType(order.service_type);
      document.getElementById("detailPickup").textContent = order.pickup_address || "--";
      document.getElementById("detailDropoff").textContent = order.dropoff_address || "--";
      document.getElementById("detailStatus").textContent = formatStatus(order.status);
      updateTimeline(order);
      readyMap(order);
      await fetchDriverLocation(currentDriverId, order.id);
      if (order.status !== "completed" && order.status !== "cancelled") startPolling();
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
  window.addEventListener("beforeunload", stopPolling);
})();
