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

  // US ZIP for the order form: 5 digits, optional +4. Spaces/dashes the
  // phone keyboard adds around it are ignored.
  function isValidZip(zip) {
    return /^\d{5}(-?\d{4})?$/.test(String(zip == null ? "" : zip).trim());
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

  // Customer-facing message for a failed /api/create-order call.
  // result is CoyoteAPI's { ok:false, error, status }. 4xx/503 messages come
  // from our own validation / weather hold and are safe to show; 5xx bodies can
  // carry internal error text, so those get a generic line instead.
  var SUPPORT_PHONE = "(361) 555-1234";
  function orderErrorMessage(result) {
    var generic = "Something went wrong placing your order. Please try again or call " + SUPPORT_PHONE + ".";
    if (!result) return generic;
    var r = result;
    var status = Number(r.status) || 0;
    var msg = String(r.error || "").trim();
    if (status === 0) {
      return "We couldn't reach Coyote's servers. Check your signal and tap Place Order again. Nothing was charged.";
    }
    if (status === 503) {
      return msg || "Deliveries are paused right now. Please try again later.";
    }
    if (status >= 400 && status < 500 && msg && msg !== "Request failed") {
      return msg;
    }
    return generic;
  }

  // Inline message for the "Track an Existing Order" box on /order/.
  // kind: "missing" (a field is empty) or a CoyoteAPI failure result.
  function trackErrorMessage(kind) {
    if (kind === "missing") return "Enter both your order number and the phone number used for the order.";
    var status = Number(kind && kind.status) || 0;
    if (kind && kind.ok === false && status === 0) {
      return "We couldn't reach Coyote's servers. Check your signal and try again.";
    }
    if (status >= 500) return "We couldn't look up your order right now. Please try again in a moment.";
    return "We couldn't find that order. Check the order number and phone number.";
  }

  var TERMINAL = ["completed", "cancelled", "delivered"];
  function isTerminalStatus(status) {
    return TERMINAL.indexOf(String(status || "").toLowerCase()) !== -1;
  }

  // <input type="date|time"> values are local wall-clock strings. Never derive
  // them from toISOString() (UTC): after ~7 PM in Texas that rolls the date to
  // tomorrow and blocks booking for tonight.
  function pad2(n) {
    return (n < 10 ? "0" : "") + n;
  }
  function localDateInputValue(d) {
    return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate());
  }
  function localTimeInputValue(d) {
    return pad2(d.getHours()) + ":" + pad2(d.getMinutes());
  }

  // ── Central time (the service runs on Port Aransas time) ──
  // The order form's date/time inputs are Central wall-clock values whatever
  // time zone the customer's phone is set to (tourists often have Pacific or
  // Eastern phones). They are sent as an ISO string with the Central offset.
  var SERVICE_TZ = "America/Chicago";
  var centralFmt = null;
  function centralWall(d) {
    if (!centralFmt) {
      centralFmt = new Intl.DateTimeFormat("en-CA", {
        timeZone: SERVICE_TZ, year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23"
      });
    }
    var p = {};
    centralFmt.formatToParts(d).forEach(function (x) { p[x.type] = x.value; });
    return { y: +p.year, mo: +p.month, d: +p.day, h: +p.hour, mi: +p.minute, s: +p.second };
  }
  // Minutes east of UTC for Central at an instant (-300 CDT, -360 CST).
  function centralOffsetMinutes(instant) {
    var w = centralWall(instant);
    var asUtc = Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s);
    return Math.round((asUtc - Math.floor(instant.getTime() / 1000) * 1000) / 60000);
  }
  function centralParts(d) {
    var w = centralWall(d);
    return { date: w.y + "-" + pad2(w.mo) + "-" + pad2(w.d), time: pad2(w.h) + ":" + pad2(w.mi) };
  }
  // Instant for a Central wall-clock date ("YYYY-MM-DD") + time ("HH:MM").
  function centralInstant(date, time) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date || ""));
    var t = /^(\d{2}):(\d{2})/.exec(String(time || ""));
    if (!m || !t) return null;
    var wallUtc = Date.UTC(+m[1], +m[2] - 1, +m[3], +t[1], +t[2]);
    var guess = new Date(wallUtc - centralOffsetMinutes(new Date(wallUtc)) * 60000);
    var off = centralOffsetMinutes(guess); // re-check across a DST boundary
    return new Date(wallUtc - off * 60000);
  }
  function formatOffset(min) {
    var sign = min < 0 ? "-" : "+";
    var a = Math.abs(min);
    return sign + pad2(Math.floor(a / 60)) + ":" + pad2(a % 60);
  }
  // "2026-10-18T20:30:00-05:00" for the Central wall time.
  function centralIso(date, time) {
    var inst = centralInstant(date, time);
    if (!inst) return null;
    return date + "T" + String(time).slice(0, 5) + ":00" + formatOffset(centralOffsetMinutes(inst));
  }
  // "Sun, Oct 18, 8:30 PM CDT"
  function formatCentral(instant) {
    return instant.toLocaleString("en-US", {
      timeZone: SERVICE_TZ, weekday: "short", month: "short", day: "numeric",
      hour: "numeric", minute: "2-digit", timeZoneName: "short"
    });
  }

  // Default slot for the order form: now + leadMinutes (default 30), plus the
  // earliest selectable date (today), both in Central time.
  function defaultServiceSlot(now, leadMinutes) {
    var base = now ? new Date(now.getTime()) : new Date();
    var slot = new Date(base.getTime() + (leadMinutes == null ? 30 : leadMinutes) * 60000);
    var sp = centralParts(slot);
    return {
      date: sp.date,
      time: sp.time,
      minDate: centralParts(base).date
    };
  }

  var api = {
    CITIES: CITIES,
    SERVICES: SERVICES,
    CATEGORIES: CATEGORIES,
    isCity: isCity,
    isValidZip: isValidZip,
    categoryById: categoryById,
    matchCategory: matchCategory,
    planRoute: planRoute,
    buildOrderUrl: buildOrderUrl,
    parseOrderParams: parseOrderParams,
    saveTrackingToken: saveTrackingToken,
    getTrackingToken: getTrackingToken,
    clearTrackingToken: clearTrackingToken,
    buildTrackUrl: buildTrackUrl,
    isTerminalStatus: isTerminalStatus,
    localDateInputValue: localDateInputValue,
    localTimeInputValue: localTimeInputValue,
    defaultServiceSlot: defaultServiceSlot,
    SERVICE_TZ: SERVICE_TZ,
    centralParts: centralParts,
    centralInstant: centralInstant,
    centralIso: centralIso,
    formatCentral: formatCentral
  };

  api.orderErrorMessage = orderErrorMessage;
  api.trackErrorMessage = trackErrorMessage;
  root.CoyoteCoastal = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
