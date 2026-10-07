/**
 * Deprecated alias. Keep the Netlify route so old clients do not 404.
 * New code should POST /api/create-order.
 */
module.exports = require("./create-order");
