/* Home page "Delivery Zones" map — real geography instead of an illustration.
   Zone ids/names mirror the beach hubs in frontend/js/zones.js (CoyoteZones).
   Leaflet (self-hosted in /vendor) is only fetched when the section nears the
   viewport, so the home page stays light for visitors who never scroll here.

   EDITING ZONES: `gulf` is the beach line, north -> south, as [lat, lng].
   `depth` is how far inland the zone reaches, in degrees of longitude
   (0.01 is roughly 1 km here). Shapes are a marketing overview only —
   pricing and eligibility still come from zones.js / the zones function. */
(function (root) {
  "use strict";

  var ZONES = [
    { id: "port-aransas", name: "Port Aransas", color: "#C2703D", depth: 0.030,
      gulf: [[27.8352, -97.0452], [27.8266, -97.0503], [27.8150, -97.0585], [27.8010, -97.0690], [27.7850, -97.0808]] },
    { id: "mustang-island", name: "Mustang Island", color: "#2F7F86", depth: 0.022,
      gulf: [[27.7850, -97.0808], [27.7500, -97.1068], [27.7150, -97.1325], [27.6730, -97.1640], [27.6400, -97.1845], [27.6185, -97.1962]] },
    { id: "padre-island", name: "North Padre Island", color: "#1A3A5C", depth: 0.030,
      gulf: [[27.6150, -97.1985], [27.5985, -97.2085], [27.5815, -97.2180], [27.5500, -97.2330], [27.5100, -97.2520], [27.4760, -97.2690]] }
  ];

  var LANDMARKS = [
    ["Horace Caldwell Pier", 27.8266, -97.0503],
    ["Mustang Island State Park", 27.6730, -97.1700],
    ["Packery Channel", 27.6168, -97.2000],
    ["Bob Hall Pier", 27.5815, -97.2185],
    ["Padre Island National Seashore (north boundary)", 27.4760, -97.2800]
  ];

  var LEAFLET = "/vendor/leaflet-1.9.4/";

  /* Beach line out, then back along the inland side -> a strip polygon. */
  function zonePolygon(z) {
    var seaward = z.gulf.map(function (p) { return [p[0] - 0.001, p[1] + 0.0016]; });
    var inland = z.gulf.slice().reverse().map(function (p) { return [p[0] + 0.004 * z.depth / 0.02, p[1] - z.depth]; });
    return seaward.concat(inland);
  }

  var api = { ZONES: ZONES, LANDMARKS: LANDMARKS, zonePolygon: zonePolygon };
  if (typeof module !== "undefined" && module.exports) { module.exports = api; return; }
  root.CoyoteZonesMap = api;

  var doc = root.document;
  var el = doc && doc.getElementById("zoneMap");
  if (!el || el.getAttribute("data-zone-map")) return;
  el.setAttribute("data-zone-map", "1");

  function loadLeaflet(done) {
    if (root.L) return done();
    var css = doc.createElement("link");
    css.rel = "stylesheet"; css.href = LEAFLET + "leaflet.css";
    doc.head.appendChild(css);
    var js = doc.createElement("script");
    js.src = LEAFLET + "leaflet.js"; js.async = true;
    js.onload = done;
    js.onerror = function () { el.classList.add("zone-map-failed"); };
    doc.head.appendChild(js);
  }

  function init() {
    var L = root.L;
    if (!L) { el.classList.add("zone-map-failed"); return; }
    var touch = root.matchMedia && root.matchMedia("(pointer: coarse)").matches;
    // Touch: one finger scrolls the page, two fingers move the map (same as /track/).
    var map = L.map(el, { scrollWheelZoom: false, dragging: !touch, tap: false });
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 18, className: "zone-map-tiles",
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
    }).addTo(map);

    var all = L.featureGroup().addTo(map);
    var polys = [];
    ZONES.forEach(function (z) {
      var base = { color: z.color, weight: 2, fillColor: z.color, fillOpacity: 0.3 };
      var poly = L.polygon(zonePolygon(z), base).addTo(all);
      poly.bindTooltip(z.name, { permanent: true, direction: "right", offset: [22, 0], className: "zone-map-label" });
      polys.push(poly);
      var card = doc.querySelector('.zone-card[data-zone="' + z.id + '"]');
      function on() { poly.setStyle({ weight: 4, fillOpacity: 0.5 }); if (card) card.classList.add("is-active"); }
      function off() { poly.setStyle(base); if (card) card.classList.remove("is-active"); }
      poly.on("mouseover", on).on("mouseout", off);
      if (card && !touch) {
        // Desktop only: the map sits beside the cards there. On phones it is
        // off-screen above them, so a tap would appear to do nothing.
        card.addEventListener("mouseenter", on);
        card.addEventListener("mouseleave", off);
        card.addEventListener("click", function () { map.flyToBounds(poly.getBounds(), { padding: [40, 40], duration: 0.6 }); });
      }
    });

    var pin = L.divIcon({ className: "", html: '<span class="zone-map-pin"></span>', iconSize: [12, 12], iconAnchor: [6, 6] });
    LANDMARKS.forEach(function (m) {
      L.marker([m[1], m[2]], { icon: pin, keyboard: false }).addTo(map)
        .bindTooltip(m[0], { direction: "left", offset: [-8, 0] });
    });

    /* Zone names sit to the right (over open Gulf). On a narrow map the
       northernmost one would run off the edge, so flip any that don't fit. */
    function setSide(tip, side) {
      tip.options.direction = side;
      tip.options.offset = L.point(side === "right" ? 22 : -22, 0);
      tip.update();
    }
    function placeLabels() {
      var edge = el.getBoundingClientRect().right - 4;
      polys.forEach(function (poly) {
        var tip = poly.getTooltip();
        if (!tip || !tip.getElement()) return;
        setSide(tip, "right");
        if (tip.getElement().getBoundingClientRect().right > edge) setSide(tip, "left");
      });
    }

    function fit() {
      map.invalidateSize();
      map.fitBounds(all.getBounds(), { padding: [20, 20], animate: false });
      placeLabels();
    }
    fit();
    el.classList.add("zone-map-ready");
    var t;
    root.addEventListener("resize", function () { clearTimeout(t); t = setTimeout(fit, 150); });
  }

  function start() { loadLeaflet(init); }
  if ("IntersectionObserver" in root) {
    var io = new IntersectionObserver(function (entries) {
      if (entries.some(function (e) { return e.isIntersecting; })) { io.disconnect(); start(); }
    }, { rootMargin: "600px 0px" });
    io.observe(el);
  } else { start(); }
})(typeof window !== "undefined" ? window : this);
