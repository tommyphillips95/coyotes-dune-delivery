/* Home page: search, location, category entry points and route planner.
   All pricing comes from CoyoteCoastal.planRoute → CoyoteZones.priceQuote. */
(function () {
  "use strict";
  var C = window.CoyoteCoastal;
  if (!C) return;

  function $(id) { return document.getElementById(id); }
  function heroCity() { var el = $("ccHeroCity"); return el && C.isCity(el.value) ? el.value : null; }

  // Search → category deep link
  var search = $("ccSearch");
  if (search) {
    search.addEventListener("submit", function (e) {
      e.preventDefault();
      var q = ($("ccSearchInput").value || "").trim();
      var cat = C.matchCategory(q) || "packages";
      window.location.href = C.buildOrderUrl({ category: cat, pickup: heroCity(), q: q || null });
    });
  }

  // Category cards carry the chosen beach town through
  var cats = $("ccCategories");
  if (cats) {
    cats.addEventListener("click", function (e) {
      var a = e.target.closest("a[data-category]");
      if (!a) return;
      e.preventDefault();
      window.location.href = C.buildOrderUrl({ category: a.getAttribute("data-category"), pickup: heroCity() });
    });
  }

  // Route planner
  var svc = $("ccService"), pick = $("ccPickup"), drop = $("ccDropoff");
  if (!svc || !pick || !drop) return;
  var pax = $("ccPax"), pkg = $("ccPkg");

  function money(n) { return "$" + Number(n).toFixed(2); }

  function render() {
    var isRide = svc.value === "ride";
    $("ccPaxField").hidden = !isRide;
    $("ccPkgField").hidden = isRide;
    var plan = C.planRoute(pick.value, drop.value, svc.value, {
      passenger_count: isRide ? pax.value : 1,
      package_size: isRide ? null : pkg.value
    });
    if (!plan) {
      $("ccTotal").textContent = "—";
      $("ccTags").innerHTML = "";
      $("ccBreakdown").innerHTML = '<tr><td class="cc-empty">Pricing unavailable. Please refresh.</td></tr>';
      return;
    }
    $("ccTotal").textContent = plan.totalText;
    var tags = '<span class="cc-tag">' + plan.miles + " mi</span>";
    tags += '<span class="cc-tag' + (plan.beach ? " coral" : "") + '">' + plan.vehicleLabel + "</span>";
    $("ccTags").innerHTML = tags;
    $("ccBreakdown").innerHTML = plan.breakdown.map(function (r) {
      return "<tr><td>" + r[0] + "</td><td>" + money(r[1]) + "</td></tr>";
    }).join("");
    $("ccBook").href = C.buildOrderUrl({ service: plan.service, pickup: plan.pickup, dropoff: plan.dropoff });
  }

  [svc, pick, drop, pax, pkg].forEach(function (el) { if (el) el.addEventListener("change", render); });
  $("ccSwap").addEventListener("click", function () {
    var t = pick.value; pick.value = drop.value; drop.value = t; render();
  });
  var hc = $("ccHeroCity");
  if (hc) hc.addEventListener("change", function () { if (C.isCity(hc.value)) { pick.value = hc.value; render(); } });
  render();
})();
