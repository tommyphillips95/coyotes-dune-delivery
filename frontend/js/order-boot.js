/* Load zones.js and add Mustang Island to city selects.
   Safe if the HTML already includes both. */
(function () {
  function addMustang(sel) {
    if (!sel) return;
    var exists = false;
    for (var i = 0; i < sel.options.length; i++) {
      if (sel.options[i].value === "Mustang Island") exists = true;
    }
    if (exists) return;
    var opt = document.createElement("option");
    opt.value = "Mustang Island";
    opt.textContent = "Mustang Island";
    var padre = null;
    for (var j = 0; j < sel.options.length; j++) {
      if (sel.options[j].value === "Padre Island") padre = sel.options[j];
    }
    sel.insertBefore(opt, padre);
  }

  function boot() {
    addMustang(document.getElementById("pickupCity"));
    addMustang(document.getElementById("dropoffCity"));
  }

  if (typeof CoyoteZones === "undefined") {
    var s = document.createElement("script");
    s.src = "../js/zones.js";
    s.onload = boot;
    document.head.appendChild(s);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
