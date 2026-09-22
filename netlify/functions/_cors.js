/** Lock CORS to the live domain. Set SITE_ORIGIN in Netlify env. */
function allowedOrigin(event) {
  const configured = (process.env.SITE_ORIGIN || "").split(",").map((s) => s.trim()).filter(Boolean);
  const requestOrigin = (event.headers && (event.headers.origin || event.headers.Origin)) || "";
  if (configured.includes(requestOrigin)) return requestOrigin;
  if (configured.length) return configured[0];
  if (/localhost|127\.0\.0\.1/.test(requestOrigin)) return requestOrigin;
  return "https://coyotes-dune-delivery.netlify.app";
}

function headers(event, extra) {
  return Object.assign(
    {
      "Access-Control-Allow-Origin": allowedOrigin(event),
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
      Vary: "Origin",
    },
    extra || {}
  );
}

module.exports = { allowedOrigin, headers };
