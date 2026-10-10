/* Coastal Coyote — shared customer-experience helpers.
   Route planner, service/category entry points, order-URL handoff and
   tracking-token storage. Pricing always comes from CoyoteZones.priceQuote
   (frontend/js/zones.js), which mirrors netlify/functions/zones.js. The
   server re-prices every order; nothing here is trusted for payment. */
(function (root) {
  "use strict";

  var CITIES = ["Port Aransas", "Mustang Island", "Padre Island", "Corpus Christi", "Rockport"];

  var SERVICES = {
    ride: "On-Demand Ride",
    package_delivery: "Package Delivery",
    grocery_run: "Grocery & Supply Run",
    group_transport: "Group Transport"
  };

  // Order form currently offers ride + package_delivery; categories map onto those
  // so the backend contract (create-order + priceQuote) is unchanged.
  var CATEGORIES = [
    { id: "food", label: "Restaurants", blurb: "Tacos, seafood, pizza from island kitchens", service: "package_delivery", note: "Restaurant pickup" },
    { id: "groceries", label: "Groceries", blurb: "Market runs, coolers stocked, ice included", service: "package_delivery", note: "Grocery run" },
    { id: "bait", label: "Bait & Tackle", blurb: "Live bait, tackle, and pier supplies", service: "package_delivery", note: "Bait & tackle pickup" },
    { id: "essentials", label: "Beach Essentials", blurb: "Sunscreen, towels, chairs, cold drinks", service: "package_delivery", note: "Beach essentials" },
    { id: "rides", label: "Rides", blurb: "Island hops, beach access, airport runs", service: "ride", note: "" },
    { id: "packages", label: "Packages", blurb: "Send anything across the Coastal Bend", service: "package_delivery", note: "" }
  ];

  var KEYWORDS = {
    food: ["taco", "food", "restaurant", "pizza", "burger", "seafood", "shrimp", "lunch", "dinner", "breakfast"],
    groceries: ["grocery", "groceries", "market", "milk", "bread", "cooler", "beer", "ice", "drink", "water"],
    bait: ["bait", "tackle", "fish", "fishing", "shrimp bait", "hook", "pier"],
    essentials: ["sunscreen", "towel", "chair", "umbrella", "essentials", "beach", "toy", "kite"],
    rides: ["ride", "taxi", "lift", "airport", "pickup me", "uber"],
    packages: ["package", "parcel", "box", "send", "deliver", "delivery"]
  };

  function zones() {
    return root.CoyoteZones || null;
  }

  function isCity(name) {
    return CITIES.indexOf(String(name || "")) !== -1;
  }

  function categoryById(id) {
    for (var i = 0; i < CATEGORIES.length; i++) if (CATEGORIES[i].id === id) return CATEGORIES[i];
    return null;
  }

  /** Map a free-text search ("tacos", "live bait") to a category id. */
  function matchCategory(query) {
    var q = String(query || "").toLowerCase();
    if (!q.trim()) return null;
    // Bait first so "shrimp bait" beats "shrimp" (food).
    var order = ["bait", "rides", "food", "groceries", "essentials", "packages"];
    for (var i = 0; i < order.length; i++) {
      var words = KEYWORDS[order[i]];
      for (var j = 0; j < words.length; j++) if (q.indexOf(words[j]) !== -1) return order[i];
    }
    return "packages";
  }

  /**
   * Route planner: same numbers create-order will store as estimated_price.
   * Returns null when zones.js isn't loaded or cities are invalid.
   */
  function planRoute(pickup, dropoff, service, opts) {
    var z = zones();
    if (!z || !isCity(pickup)) return null;
    var drop = isCity(dropoff) ? dropoff : pickup;
    var svc = SERVICES[service] ? service : "ride";
    var o = opts || {};
    var q = z.priceQuote(pickup, drop, {
      service_type: svc,
      passenger_count: o.passenger_count,
      package_size: o.package_size
    });
    var vehicle = q.requiredClass === "4x4" ? "4x4 (beach access)" : "Standard car";
    return {
      pickup: pickup,
      dropoff: drop,
      service: svc,
      serviceLabel: SERVICES[svc],
      miles: q.miles,
      beach: q.beach,
      requiredClass: q.requiredClass,
      vehicleLabel: vehicle,
      total: q.total,
      totalText: "$" + q.total.toFixed(2),
      breakdown: [
        ["Base", q.base],
        [q.miles + " mi × $" + q.perMile.toFixed(2), Math.round(q.miles * q.perMile * 100) / 100],
        ["Beach / sand access", q.beachSurcharge],
        ["Extra passengers", q.extraPassenger],
        ["Large package", q.packageAdd]
      ].filter(function (row) { return row[1] > 0; })
    };
  }

  /** Build an /order/ deep link. Only known values are emitted. */
  function buildOrderUrl(p) {
    var params = [];
    var v = p || {};
    if (SERVICES[v.service]) params.push("service=" + encodeURIComponent(v.service));
    if (categoryById(v.category)) params.push("category=" + encodeURIComponent(v.category));
    if (isCity(v.pickup)) params.push("pickup=" + encodeURIComponent(v.pickup));
    if (isCity(v.dropoff)) params.push("dropoff=" + encodeURIComponent(v.dropoff));
    if (v.q) params.push("q=" + encodeURIComponent(String(v.q).slice(0, 120)));
    return "/order/" + (params.length ? "?" + params.join("&") : "");
  }

  /** Parse and whitelist /order/ query params (never trust raw input). */
  function parseOrderParams(search) {
    var out = { service: null, category: null, pickup: null, dropoff: null, q: null, track: null };
    var s = String(search || "").replace(/^\?/, "");
    if (!s) return out;
    s.split("&").forEach(function (pair) {
      var idx = pair.indexOf("=");
      var k = decodeURIComponent((idx === -1 ? pair : pair.slice(0, idx)).replace(/\+/g, " "));
      var raw = idx === -1 ? "" : pair.slice(idx + 1);
      var val;
      try { val = decodeURIComponent(raw.replace(/\+/g, " ")); } catch (e) { val = ""; }
      if (k === "service" && SERVICES[val]) out.service = val;
      else if (k === "category" && categoryById(val)) out.category = val;
      else if (k === "pickup" && isCity(val)) out.pickup = val;
      else if (k === "dropoff" && isCity(val)) out.dropoff = val;
      else if (k === "q" && val) out.q = val.slice(0, 120);
      else if ((k === "track" || k === "order") && /^[A-Z0-9-]{4,40}$/i.test(val)) out.track = val.toUpperCase();
    });
    if (out.category && !out.service) out.service = categoryById(out.category).service;
    return out;
  }

  // ── Tracking token storage (customer JWT minted by create-order / get-orders) ──
  var TOKEN_KEY = "cdd_tracking_tokens";

  function storage(store) {
    if (store) return store;
    try { return root.localStorage || null; } catch (e) { return null; }
  }

  function readTokens(store) {
    var s = storage(store);
    if (!s) return {};
    try { return JSON.parse(s.getItem(TOKEN_KEY) || "{}") || {}; } catch (e) { return {}; }
  }

  function saveTrackingToken(orderNumber, token, store) {
    var s = storage(store);
    if (!s || !orderNumber || !token) return false;
    var all = readTokens(s);
    // Monotonic stamp so the token just saved is never evicted on a same-ms tie.
    var newest = 0;
    Object.keys(all).forEach(function (k) { if (all[k] && all[k].savedAt > newest) newest = all[k].savedAt; });
    all[String(orderNumber).toUpperCase()] = { token: token, savedAt: Math.max(Date.now(), newest + 1) };
    // Keep the 10 newest so localStorage doesn't grow forever.
    var keys = Object.keys(all).sort(function (a, b) { return all[b].savedAt - all[a].savedAt; });
    keys.slice(10).forEach(function (k) { delete all[k]; });
    s.setItem(TOKEN_KEY, JSON.stringify(all));
    return true;
  }

  function getTrackingToken(orderNumber, store) {
    if (!orderNumber) return null;
    var entry = readTokens(store)[String(orderNumber).toUpperCase()];
    return entry ? entry.token : null;
  }

  function clearTrackingToken(orderNumber, store) {
    var s = storage(store);
    if (!s || !orderNumber) return;
    var all = readTokens(s);
    delete all[String(orderNumber).toUpperCase()];
    s.setItem(TOKEN_KEY, JSON.stringify(all));
  }

  function buildTrackUrl(orderNumber) {
    return "/track/?order=" + encodeURIComponent(String(orderNumber || "").toUpperCase());
  }

  var TERMINAL = ["completed", "cancelled", "delivered"];
  function isTerminalStatus(status) {
    return TERMINAL.indexOf(String(status || "").toLowerCase()) !== -1;
  }

  var api = {
    CITIES: CITIES,
    SERVICES: SERVICES,
    CATEGORIES: CATEGORIES,
    isCity: isCity,
    categoryById: categoryById,
    matchCategory: matchCategory,
    planRoute: planRoute,
    buildOrderUrl: buildOrderUrl,
    parseOrderParams: parseOrderParams,
    saveTrackingToken: saveTrackingToken,
    getTrackingToken: getTrackingToken,
    clearTrackingToken: clearTrackingToken,
    buildTrackUrl: buildTrackUrl,
    isTerminalStatus: isTerminalStatus
  };

  root.CoyoteCoastal = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
