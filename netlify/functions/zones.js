/** Shared Coastal Bend zone + price table for Netlify functions.
 *  Keep in sync with frontend/js/zones.js. */
const ZONES = {
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
    "Corpus Christi-Rockport": 30,
  },
  beachCities: ["Port Aransas", "Mustang Island", "Padre Island"],
  hubs: {
    "Port Aransas": { lat: 27.8339, lng: -97.0611, beach: true },
    "Mustang Island": { lat: 27.74, lng: -97.13, beach: true },
    "Padre Island": { lat: 27.5772, lng: -97.2736, beach: true },
    "Corpus Christi": { lat: 27.8006, lng: -97.3964, beach: false },
    "Rockport": { lat: 28.0206, lng: -97.0544, beach: false },
  },
  rates: {
    ride: { base: 12, per_mile: 2.5 },
    package_delivery: { base: 15, per_mile: 2.0 },
    grocery_run: { base: 18, per_mile: 1.5 },
    group_transport: { base: 35, per_mile: 3.0 },
  },
  beachSurcharge: 8,
  extraPassenger: 3,
  packageLarge: 8,
  packageOversized: 15,
};

function haversineMi(aLat, aLng, bLat, bLng) {
  const R = 3958.8;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
}

function milesBetween(pickupCity, dropoffCity) {
  const a = (pickupCity || "").trim();
  const b = (dropoffCity || pickupCity || "").trim();
  if (typeof ZONES.miles[`${a}-${b}`] === "number") return ZONES.miles[`${a}-${b}`];
  const ha = ZONES.hubs[a];
  const hb = ZONES.hubs[b];
  if (ha && hb) return Math.round(haversineMi(ha.lat, ha.lng, hb.lat, hb.lng) * 10) / 10;
  return 10;
}

function isBeachCity(city) {
  return ZONES.beachCities.includes((city || "").trim());
}

function requiredClass(pickupCity, dropoffCity) {
  return isBeachCity(pickupCity) || isBeachCity(dropoffCity) ? "4x4" : "2wd";
}

function quote(pickupCity, dropoffCity) {
  const miles = milesBetween(pickupCity, dropoffCity);
  const beach = isBeachCity(pickupCity) || isBeachCity(dropoffCity);
  return { miles, beach, requiredClass: requiredClass(pickupCity, dropoffCity) };
}

function priceQuote(pickupCity, dropoffCity, opts) {
  const o = opts || {};
  const q = quote(pickupCity, dropoffCity);
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
    beachSurcharge,
    extraPassenger: extraPax,
    packageAdd: pkg,
    total,
  });
}

module.exports = { ZONES, milesBetween, isBeachCity, requiredClass, quote, priceQuote };
