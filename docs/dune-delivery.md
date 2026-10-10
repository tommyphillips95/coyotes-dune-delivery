# Coyote's Dune Delivery

Repo: https://github.com/tommyphillips95/coyotes-dune-delivery (public)
Snapshot: 2026-09-22

## Branches

- `main` — last product snapshot
- `agent/grok/launch-ready` — first launch commit (zones stub + /status rewrite) — PR #1
- `agent/grok/cdd-launch-v1` — pricing + live GPS + launch hygiene

## This slice (cdd-launch-v1)

- Zone table drives server estimate in `create-order.js`
- Beach destinations require 4x4 class + $8 sand surcharge
- Track page polls GPS every 15s; Leaflet map (no Google key required)
- `/api/submit-order` is routed to `create-order` in `netlify.toml` (one function, one contract)
- CORS helper + `schema/launch_2026_09_22.sql` to drop SSN/bank and default admin row

Frontend `order.js` still has a leftover mile table until the next commit wires `CoyoteZones.quote`. Paid price is the server number.

## Still open before first beach order

- Run `schema/launch_2026_09_22.sql`
- SITE_ORIGIN, Stripe live, Twilio A2P, Checkr live
- Auto-offer nearest online 4x4 after payment
- Live NWS/tide API
- Express leftover quarantined in `legacy/express-backend/`; prod is Netlify (`docs/backend.md`)
- README default admin password is a finding

## Reviewer order

1. `frontend/js/zones.js`
2. `netlify/functions/create-order.js`
3. `frontend/track/track.js`
4. `schema/launch_2026_09_22.sql`
