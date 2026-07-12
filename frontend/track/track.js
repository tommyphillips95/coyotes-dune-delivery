/**
 * Coyote's Dune Delivery — Customer Tracking Page JavaScript
 * Handles order lookup, Google Maps display, real-time driver tracking,
 * ETA calculation, and status timeline updates.
 */

(function () {
  'use strict';

  // ─── Config ───
  const API_BASE = '/api';
  const POLL_INTERVAL_MS = 10000; // 10 seconds
  const GOOGLE_MAPS_API_KEY = 'YOUR_GOOGLE_MAPS_API_KEY'; // Replace with env var in production

  // ─── State ───
  let map = null;
  let driverMarker = null;
  let pickupMarker = null;
  let dropoffMarker = null;
  let routePolyline = null;
  let pollTimer = null;
  let currentOrder = null;
  let currentDriverId = null;

  // ─── DOM refs ───
  const lookupForm = document.getElementById('lookupForm');
  const lookupBtn = document.getElementById('lookupBtn');
  const mapEl = document.getElementById('map');
  const mapLoading = document.getElementById('mapLoading');
  const mapError = document.getElementById('mapError');

  // ─── Google Maps init (global callback) ───
  window.initMap = function () {
    // Map will be initialized when user looks up an order
    console.log('Google Maps API loaded');
  };

  // ─── Helpers ───
  function formatStatus(status) {
    const map = {
      pending: 'Pending',
      assigned: 'Assigned',
      in_progress: 'On the Way',
      completed: 'Completed',
      cancelled: 'Cancelled',
    };
    return map[status] || status;
  }

  function formatServiceType(type) {
    const map = {
      ride: 'On-Demand Ride',
      package_delivery: 'Package Delivery',
      grocery_run: 'Grocery Run',
      group_transport: 'Group Transport',
    };
    return map[type] || type;
  }

  function formatTime(iso) {
    if (!iso) return '--';
    const d = new Date(iso);
    return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  }

  function showCard(id) {
    const el = document.getElementById(id);
    if (el) el.classList.remove('hidden');
  }

  function hideCard(id) {
    const el = document.getElementById(id);
    if (el) el.classList.add('hidden');
  }

  // ─── Initialize Map ───
  function initOrderMap(order, driverLocation) {
    if (typeof google === 'undefined' || !google.maps) {
      mapLoading.classList.add('hidden');
      mapError.classList.remove('hidden');
      return;
    }

    mapLoading.classList.add('hidden');
    mapError.classList.add('hidden');
    mapEl.classList.remove('hidden');

    // Default center: Port Aransas, TX
    const defaultCenter = { lat: 27.8339, lng: -97.0661 };
    const center = order.pickup_lat && order.pickup_lng
      ? { lat: parseFloat(order.pickup_lat), lng: parseFloat(order.pickup_lng) }
      : defaultCenter;

    map = new google.maps.Map(mapEl, {
      center: center,
      zoom: 13,
      mapTypeId: 'roadmap',
      mapTypeControl: false,
      streetViewControl: false,
      fullscreenControl: true,
    });

    // Pickup marker
    if (order.pickup_lat && order.pickup_lng) {
      pickupMarker = new google.maps.Marker({
        position: { lat: parseFloat(order.pickup_lat), lng: parseFloat(order.pickup_lng) },
        map: map,
        title: 'Pickup: ' + order.pickup_address,
        icon: {
          url: 'data:image/svg+xml;charset=UTF-8,' + encodeURIComponent(
            '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" fill="#C9A87C" stroke="#1A2F4B" stroke-width="2"/><circle cx="12" cy="12" r="4" fill="#1A2F4B"/></svg>'
          ),
          scaledSize: new google.maps.Size(32, 32),
          anchor: new google.maps.Point(16, 16),
        },
      });
    }

    // Dropoff marker
    if (order.dropoff_lat && order.dropoff_lng) {
      dropoffMarker = new google.maps.Marker({
        position: { lat: parseFloat(order.dropoff_lat), lng: parseFloat(order.dropoff_lng) },
        map: map,
        title: 'Dropoff: ' + order.dropoff_address,
        icon: {
          url: 'data:image/svg+xml;charset=UTF-8,' + encodeURIComponent(
            '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z" fill="#1A2F4B" stroke="#C9A87C" stroke-width="2"/><circle cx="12" cy="10" r="3" fill="#C9A87C"/></svg>'
          ),
          scaledSize: new google.maps.Size(32, 32),
          anchor: new google.maps.Point(16, 28),
        },
      });
    }

    // Driver marker
    if (driverLocation && driverLocation.lat && driverLocation.lng) {
      driverMarker = new google.maps.Marker({
        position: { lat: parseFloat(driverLocation.lat), lng: parseFloat(driverLocation.lng) },
        map: map,
        title: 'Driver Location',
        icon: {
          url: 'data:image/svg+xml;charset=UTF-8,' + encodeURIComponent(
            '<svg xmlns="http://www.w3.org/2000/svg" width="36" height="36" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" fill="#4C8C64" stroke="#FFFFFF" stroke-width="2"/><text x="12" y="16" text-anchor="middle" fill="#FFFFFF" font-size="10" font-family="Arial" font-weight="bold">D</text></svg>'
          ),
          scaledSize: new google.maps.Size(36, 36),
          anchor: new google.maps.Point(18, 18),
        },
      });
    }

    // Draw route between pickup and dropoff if both exist
    if (order.pickup_lat && order.pickup_lng && order.dropoff_lat && order.dropoff_lng) {
      drawRoute(
        { lat: parseFloat(order.pickup_lat), lng: parseFloat(order.pickup_lng) },
        { lat: parseFloat(order.dropoff_lat), lng: parseFloat(order.dropoff_lng) }
      );
    }

    // Fit bounds to show all markers
    fitBounds();
  }

  // ─── Draw route using DirectionsService ───
  function drawRoute(origin, destination) {
    if (!google.maps.DirectionsService) return;

    const directionsService = new google.maps.DirectionsService();
    directionsService.route(
      {
        origin: origin,
        destination: destination,
        travelMode: google.maps.TravelMode.DRIVING,
      },
      function (result, status) {
        if (status === 'OK' && result.routes[0]) {
          routePolyline = new google.maps.Polyline({
            path: result.routes[0].overview_path,
            geodesic: true,
            strokeColor: '#C9A87C',
            strokeOpacity: 0.8,
            strokeWeight: 4,
          });
          routePolyline.setMap(map);

          // Update ETA from route duration
          const leg = result.routes[0].legs[0];
          if (leg && leg.duration) {
            updateETA(leg.duration.value); // seconds
          }
        }
      }
    );
  }

  // ─── Fit bounds ───
  function fitBounds() {
    if (!map) return;
    const bounds = new google.maps.LatLngBounds();
    let hasPoints = false;

    if (pickupMarker) { bounds.extend(pickupMarker.getPosition()); hasPoints = true; }
    if (dropoffMarker) { bounds.extend(dropoffMarker.getPosition()); hasPoints = true; }
    if (driverMarker) { bounds.extend(driverMarker.getPosition()); hasPoints = true; }

    if (hasPoints) {
      map.fitBounds(bounds, { padding: 60 });
    }
  }

  // ─── Update driver marker position ───
  function updateDriverMarker(lat, lng) {
    if (!map) return;
    const pos = { lat: parseFloat(lat), lng: parseFloat(lng) };

    if (driverMarker) {
      driverMarker.setPosition(pos);
    } else {
      driverMarker = new google.maps.Marker({
        position: pos,
        map: map,
        title: 'Driver Location',
        icon: {
          url: 'data:image/svg+xml;charset=UTF-8,' + encodeURIComponent(
            '<svg xmlns="http://www.w3.org/2000/svg" width="36" height="36" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" fill="#4C8C64" stroke="#FFFFFF" stroke-width="2"/><text x="12" y="16" text-anchor="middle" fill="#FFFFFF" font-size="10" font-family="Arial" font-weight="bold">D</text></svg>'
          ),
          scaledSize: new google.maps.Size(36, 36),
          anchor: new google.maps.Point(18, 18),
        },
      });
    }

    // Recalculate ETA if we have dropoff
    if (currentOrder && currentOrder.dropoff_lat && currentOrder.dropoff_lng) {
      const directionsService = new google.maps.DirectionsService();
      directionsService.route(
        {
          origin: pos,
          destination: { lat: parseFloat(currentOrder.dropoff_lat), lng: parseFloat(currentOrder.dropoff_lng) },
          travelMode: google.maps.TravelMode.DRIVING,
        },
        function (result, status) {
          if (status === 'OK' && result.routes[0] && result.routes[0].legs[0]) {
            updateETA(result.routes[0].legs[0].duration.value);
          }
        }
      );
    }

    fitBounds();
  }

  // ─── Update ETA display ───
  function updateETA(seconds) {
    const etaValue = document.getElementById('etaValue');
    const etaUnit = document.getElementById('etaUnit');
    if (!etaValue) return;

    if (seconds < 60) {
      etaValue.textContent = '< 1';
      etaUnit.textContent = 'minute';
    } else {
      const minutes = Math.round(seconds / 60);
      etaValue.textContent = minutes;
      etaUnit.textContent = minutes === 1 ? 'minute' : 'minutes';
    }
  }

  // ─── Update status timeline ───
  function updateTimeline(order) {
    const statuses = ['pending', 'assigned', 'in_progress', 'completed'];
    const currentIndex = statuses.indexOf(order.status);

    statuses.forEach((s, i) => {
      const dot = document.getElementById('dot' + s.charAt(0).toUpperCase() + s.slice(1).replace('_', ''));
      if (!dot) return;

      if (i < currentIndex) {
        dot.classList.add('completed');
        dot.classList.remove('active');
      } else if (i === currentIndex) {
        dot.classList.add('active');
        dot.classList.remove('completed');
      } else {
        dot.classList.remove('active', 'completed');
      }
    });

    // Update timestamps if available from status logs
    if (order.status_logs && Array.isArray(order.status_logs)) {
      order.status_logs.forEach(log => {
        const timeEl = document.getElementById('time' + log.status.charAt(0).toUpperCase() + log.status.slice(1).replace('_', ''));
        if (timeEl && log.created_at) {
          timeEl.textContent = formatTime(log.created_at);
        }
      });
    }
  }

  // ─── Fetch driver location ───
  async function fetchDriverLocation(driverId, orderId) {
    try {
      let url = `${API_BASE}/get-driver-location?`;
      if (driverId) url += `driver_id=${encodeURIComponent(driverId)}`;
      else if (orderId) url += `order_id=${encodeURIComponent(orderId)}`;
      else return;

      const res = await fetch(url);
      const json = await res.json();

      if (json.success && json.data && json.data.location) {
        const loc = json.data.location;
        updateDriverMarker(loc.lat, loc.lng);

        // Update driver info if available
        if (json.data.driver) {
          const d = json.data.driver;
          document.getElementById('driverName').textContent = `${d.first_name || ''} ${d.last_name || ''}`.trim() || 'Your Driver';
          document.getElementById('driverVehicle').textContent = d.vehicle_make && d.vehicle_model
            ? `${d.vehicle_color || ''} ${d.vehicle_make} ${d.vehicle_model}`.trim()
            : 'Vehicle info unavailable';
        }
      }
    } catch (err) {
      console.error('Error fetching driver location:', err);
    }
  }

  // ─── Poll for updates ───
  function startPolling() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(() => {
      if (currentDriverId) {
        fetchDriverLocation(currentDriverId, currentOrder ? currentOrder.id : null);
      }
    }, POLL_INTERVAL_MS);
  }

  function stopPolling() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  // ─── Lookup order ───
  async function lookupOrder(orderNumber, phone) {
    lookupBtn.disabled = true;
    lookupBtn.textContent = 'Tracking...';

    try {
      const res = await fetch(`${API_BASE}/orders?order_number=${encodeURIComponent(orderNumber)}&phone=${encodeURIComponent(phone)}`);
      const json = await res.json();

      if (!json.success || !json.data || (Array.isArray(json.data) && json.data.length === 0)) {
        alert('Order not found. Please check your order number and phone number.');
        return;
      }

      const order = Array.isArray(json.data) ? json.data[0] : json.data;
      currentOrder = order;
      currentDriverId = order.driver_id || null;

      // Show tracking cards
      showCard('etaCard');
      showCard('driverCard');
      showCard('orderCard');
      showCard('timelineCard');

      // Populate order details
      document.getElementById('detailOrderNum').textContent = order.order_number;
      document.getElementById('detailService').textContent = formatServiceType(order.service_type);
      document.getElementById('detailPickup').textContent = order.pickup_address || '--';
      document.getElementById('detailDropoff').textContent = order.dropoff_address || '--';
      document.getElementById('detailStatus').textContent = formatStatus(order.status);

      // Update timeline
      updateTimeline(order);

      // Initialize map
      // Try to get driver location first, then init map
      let driverLoc = null;
      if (currentDriverId) {
        try {
          const locRes = await fetch(`${API_BASE}/get-driver-location?driver_id=${encodeURIComponent(currentDriverId)}`);
          const locJson = await locRes.json();
          if (locJson.success && locJson.data && locJson.data.location) {
            driverLoc = locJson.data.location;
            if (locJson.data.driver) {
              const d = locJson.data.driver;
              document.getElementById('driverName').textContent = `${d.first_name || ''} ${d.last_name || ''}`.trim() || 'Your Driver';
              document.getElementById('driverVehicle').textContent = d.vehicle_make && d.vehicle_model
                ? `${d.vehicle_color || ''} ${d.vehicle_make} ${d.vehicle_model}`.trim()
                : 'Vehicle info unavailable';
            }
          }
        } catch (e) {
          console.error('Could not fetch initial driver location:', e);
        }
      }

      initOrderMap(order, driverLoc);

      // Start polling for live updates
      if (order.status === 'assigned' || order.status === 'in_progress') {
        startPolling();
      }

    } catch (err) {
      console.error('Error looking up order:', err);
      alert('Something went wrong. Please try again.');
    } finally {
      lookupBtn.disabled = false;
      lookupBtn.textContent = 'Track Order';
    }
  }

  // ─── Event listeners ───
  lookupForm.addEventListener('submit', function (e) {
    e.preventDefault();
    const orderNum = document.getElementById('lookupOrderNum').value.trim();
    const phone = document.getElementById('lookupPhone').value.trim();
    if (orderNum && phone) {
      lookupOrder(orderNum, phone);
    }
  });

  // ─── Cleanup on page unload ───
  window.addEventListener('beforeunload', stopPolling);

})();
