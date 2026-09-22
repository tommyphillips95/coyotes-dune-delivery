# Coyote launch — separate from Nexform

This repo is the delivery product only.

## What already exists
Vanilla HTML/JS + Netlify Functions + Supabase + Stripe + Twilio + Checkr.
Customer order, driver apply/portal, admin dispatch, GPS ping tables.

## This branch (`agent/grok/cdd-launch-v1`)
- `frontend/js/zones.js` is the pricing source of truth (hubs, miles, 4x4 beach class, weather gate)
- `order.js` + `create-order.js` read that table instead of a 4-row hard-code
- `/track` polls `/api/get-orders` + `/api/get-driver-location` every 15s and draws on Leaflet
- Driver portal GPS ping dropped from 30s to 15s
- `submit-order` is a thin alias of `create-order` (no second implementation)
- CORS helper locks origin via `SITE_ORIGIN`
- `schema/launch_2026_09_22.sql` drops SSN/bank columns and the default admin row

## To go live this week
1. Netlify env: JWT, ADMIN_USERNAME, ADMIN_PASSWORD, SUPABASE_*, STRIPE_*, TWILIO_*, SITE_ORIGIN, FIREBASE_*
2. Run `schema.sql` then `schema/launch_2026_09_22.sql` on the Supabase project
3. Change admin password in Netlify env — never commit it
4. Do not collect SSN/bank on `/apply` (Checkr + Stripe Connect)
5. Staff: one dispatcher on `/admin`, two drivers on `/driver` with Go Online
6. Dry-run a paid test order Port A → Mustang with a 4x4 driver online
7. Twilio A2P 10DLC, Stripe live, Checkr live, privacy + terms, insurance note

Past apps: `tommyphillips95/beach-brings` (stub), this repo.
