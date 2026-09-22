/* Coastal Bend service area — vehicle class + access flags + price.
   Source of truth for order pricing, driver class, and weather holds.
   Keep in sync with netlify/functions/zones.js. */
(function (root) {
  const ZONES = {
    market: "Texas Gulf Coast",
    hubs: [
      { id: "port-aransas", name: "Port Aransas", lat: 27.8339, lng: -97.0611, beach: true, mileMarkers: ["PA-1", "PA-5", "PA-10"] },
      { id: "mustang-island", name: "Mustang Island", lat: 27.74, lng: -97.13, beach: true, mileMarkers: ["MI-5", "MI-10"] },
      { id: "padre-island", name: "Padre Island", lat: 27.5772, lng: -97.2736, beach: true, mileMarkers: ["NP-1", "NP-6"] },
      { id: "corpus", name: "Corpus Christi", lat: 27.8006, lng: -97.3964, beach: false, mileMarkers: [] },
      { id: "rockport", name: "Rockport", lat: 28.0206, lng: -97.0544, beach: false, mileMarkers: [] }
    ],
    miles: {
      "Port Aransas-Padre Island": 18,
      "Padre Island-Port Aransas": 18,
      "Port Aransas-Port Aransas": 4,
      "Padre Island-Padre Island": 5,
      "Port Aransas-Mustang Island": 6,
      "Mustang Island-Port Aransas": 6,
      "Mustang Island-Padre Island": 14,
      "Padre Island-Mustang Island": 14,
      "Mustang Island-Mustang Island": 4,
      "Corpus Christi-Port Aransas": 35,
      "Port Aransas-Corpus Christi": 35,
      "Corpus Christi-Padre Island": 22,
      "Padre Island-Corpus Christi": 22,
      "Corpus Christi-Mustang Island": 28,
      "Mustang Island-Corpus Christi": 28,
      "Corpus Christi-Corpus Christi": 6,
      "Rockport-Port Aransas": 25,
      "Port Aransas-Rockport": 25,
      "Rockport-Rockport": 5,
      "Rockport-Corpus Christi": 30,
      "Corpus Christi-Rockport": 30
    },
    vehicleClasses: [
      { id: "2wd", label: "2WD car / small SUV", sand: false, beach_access: false },
      { id: "awd", label: "AWD / high clearance", sand: "limited", beach_access: true },
      { id: "4x4", label: "4x4 pickup", sand: true, beach_access: true },
      { id: "utv", label: "UTV / side-by-side", sand: true, beach_access: true },
      { id: "cart", label: "Golf cart (island only)", sand: "limited", beach_access: true }
    ],
    weatherGate: {
      wind_mph_hold: 35,
      lightning_hold: true,
      tropical_hold: true
    },
    rates: {
      ride: { base: 12, per_mile: 2.5 },
      package_delivery: { base: 15, per_mile: 2.0 },
      grocery_run: { base: 18, per_mile: 1.5 },
      group_transport: { base: 35, per_mile: 3.0 }
    },
    beachSurcharge: 8,
    extraPassenger: 3,
    packageLarge: 8,
    packageOversized: 15
  };

  function norm(name) {
    return String(name || "").trim().toLowerCase();
  }

  function hubByName(name) {
    const n = norm(name);
    return ZONES.hubs.find(function (h) {
      return norm(h.name) === n || h.id === n || n.indexOf(norm(h.name)) !== -1;
    }) || null;
  }

  function haversineMi(aLat, aLng, bLat, bLng) {
    const R = 3958.8;
    const toRad = function (d) { return (d * Math.PI) / 180; };
    const dLat = toRad(bLat - aLat);
    const dLng = toRad(bLng - aLng);
    const s =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) *
      Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return 2 * R * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
  }

  function milesBetween(pickupCity, dropoffCity) {
    const a = String(pickupCity || "").trim();
    const b = String(dropoffCity || pickupCity || "").trim();
    const table = ZONES.miles[a + "-" + b];
    if (typeof table === "number") return table;
    const ha = hubByName(a);
    const hb = hubByName(b);
    if (ha && hb) return Math.round(haversineMi(ha.lat, ha.lng, hb.lat, hb.lng) * 10) / 10;
    return 10;
  }

  function isBeachCity(city) {
    const h = hubByName(city);
    return !!(h && h.beach);
  }

  function requiredClass(pickupCity, dropoffCity) {
    if (isBeachCity(pickupCity) || isBeachCity(dropoffCity)) return "4x4";
    return "2wd";
  }

  function weatherHold(obs) {
    const g = ZONES.weatherGate;
    const o = obs || {};
    if (o.tropical) return { hold: true, reason: "tropical" };
    if (o.lightning && g.lightning_hold) return { hold: true, reason: "lightning" };
    if (typeof o.wind_mph === "number" && o.wind_mph >= g.wind_mph_hold) {
      return { hold: true, reason: "wind" };
    }
    return { hold: false, reason: null };
  }

  function quote(pickupCity, dropoffCity, obs) {
    const miles = milesBetween(pickupCity, dropoffCity);
    const beach = isBeachCity(pickupCity) || isBeachCity(dropoffCity);
    const hold = weatherHold(obs);
    return {
      miles: miles,
      beach: beach,
      requiredClass: requiredClass(pickupCity, dropoffCity),
      hold: hold.hold,
      holdReason: hold.reason
    };
  }

  function priceQuote(pickupCity, dropoffCity, opts) {
    const o = opts || {};
    const q = quote(pickupCity, dropoffCity, o.obs);
    const rates = ZONES.rates[o.service_type || "ride"] || ZONES.rates.ride;
    let total = rates.base + q.miles * rates.per_mile;
    const beachSurcharge = q.beach ? ZONES.beachSurcharge : 0;
    total += beachSurcharge;
    const pax = parseInt(o.passenger_count || 1, 10) || 1;
    const extraPax = pax > 1 ? (pax - 1) * ZONES.extraPassenger : 0;
    total += extraPax;
    let pkg = 0;
    if (o.package_size === "large") pkg = ZONES.packageLarge;
    if (o.package_size === "oversized") pkg = ZONES.packageOversized;
    total += pkg;
    total = Math.round(total * 100) / 100;
    return Object.assign({}, q, {
      serviceType: o.service_type || "ride",
      base: rates.base,
      perMile: rates.per_mile,
      beachSurcharge: beachSurcharge,
      extraPassenger: extraPax,
      packageAdd: pkg,
      total: total
    });
  }

  root.COYOTE_ZONES = ZONES;
  root.CoyoteZones = {
    milesBetween: milesBetween,
    hubByName: hubByName,
    haversineMi: haversineMi,
    requiredClass: requiredClass,
    weatherHold: weatherHold,
    quote: quote,
    priceQuote: priceQuote,
    isBeachCity: isBeachCity
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = { ZONES: ZONES, CoyoteZones: root.CoyoteZones };
  }
})(typeof window !== "undefined" ? window : globalThis);
