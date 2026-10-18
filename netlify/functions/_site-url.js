/**
 * Customer- and driver-facing links in texts. One place builds them so the
 * domain and the /track/ format can't drift again (#68 found a text pointing
 * at the wrong *.netlify.app host and the old /order/?track= page).
 *
 * SITE_ORIGIN may be comma-separated (CORS allow-list, e.g. live + deploy
 * previews). Links use the first entry that is a valid https origin; if none
 * is, the live site.
 */
"use strict";

const DEFAULT_ORIGIN = "https://coyote-dune-delivery.netlify.app";

function siteOrigin(env) {
  const raw = String(((env || process.env).SITE_ORIGIN) || "");
  for (const part of raw.split(",")) {
    const s = part.trim();
    if (!s) continue;
    let u;
    try { u = new URL(s); } catch (e) { continue; }
    if (u.protocol !== "https:" || u.username || u.password || !u.hostname) continue;
    return u.origin; // drops any path / trailing slash
  }
  return DEFAULT_ORIGIN;
}

/** siteUrl("/track/", { order: "CDD-1" }) -> "https://…/track/?order=CDD-1" */
function siteUrl(path, params, env) {
  const p = "/" + String(path || "").replace(/^\/+/, "");
  const q = Object.keys(params || {})
    .filter((k) => params[k] != null && params[k] !== "")
    .map((k) => encodeURIComponent(k) + "=" + encodeURIComponent(String(params[k])))
    .join("&");
  return siteOrigin(env) + p + (q ? "?" + q : "");
}

/**
 * Tracking link in the format /track/ reads: ?order=<ORDER NUMBER>
 * (frontend/js/coastal.js parseOrderParams, uppercased). The page picks up
 * the tracking token saved on the device that placed the order, or asks for
 * the phone number; it has no token query param, so none is put in the URL.
 */
function trackUrl(orderNumber, env) {
  return siteUrl("/track/", { order: String(orderNumber || "").trim().toUpperCase() }, env);
}

module.exports = { DEFAULT_ORIGIN, siteOrigin, siteUrl, trackUrl };
