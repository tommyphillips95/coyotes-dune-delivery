/* Coastal Bend service area — vehicle class + access flags.
   Used by order, driver, and admin pages. Keep this the source of truth. */
window.COYOTE_ZONES = {
  market: "Texas Gulf Coast",
  hubs: [
    { id: "port-aransas", name: "Port Aransas", lat: 27.8339, lng: -97.0611 },
    { id: "padre-island", name: "Padre Island", lat: 27.5772, lng: -97.2736 },
    { id: "mustang-island", name: "Mustang Island", lat: 27.7400, lng: -97.1300 },
    { id: "corpus", name: "Corpus Christi", lat: 27.8006, lng: -97.3964 }
  ],
  miles: {
    "Port Aransas-Padre Island": 18,
    "Padre Island-Port Aransas": 18,
    "Port Aransas-Port Aransas": 4,
    "Padre Island-Padre Island": 5,
    "Port Aransas-Mustang Island": 6,
    "Mustang Island-Port Aransas": 6,
    "Corpus Christi-Port Aransas": 35,
    "Port Aransas-Corpus Christi": 35
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
  }
};
