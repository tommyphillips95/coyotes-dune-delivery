/** Shared Coastal Bend zone table for Netlify functions. Keep in sync with frontend/js/zones.js. */
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
    "Corpus Christi-Port Aransas": 35,
    "Port Aransas-Corpus Christi": 35,
    "Corpus Christi-Padre Island": 22,
    "Padre Island-Corpus Christi": 22,
    "Corpus Christi-Mustang Island": 28,
    "Mustang Island-Corpus Christi": 28,
    "Rockport-Port Aransas": 25,
    "Port Aransas-Rockport": 25,
  },
  beachCities: ["Port Aransas", "Mustang Island", "Padre Island"],
};

function milesBetween(pickupCity, dropoffCity) {
  const a = (pickupCity || "").trim();
  const b = (dropoffCity || pickupCity || "").trim();
  return ZONES.miles[`${a}-${b}`] || 10;
}

function isBeachCity(city) {
  return ZONES.beachCities.includes((city || "").trim());
}

function requiredClass(pickupCity, dropoffCity) {
  return isBeachCity(pickupCity) || isBeachCity(dropoffCity) ? "4x4" : "2wd";
}

module.exports = { ZONES, milesBetween, isBeachCity, requiredClass };
