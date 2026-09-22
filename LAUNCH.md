# Coyote launch — separate from Nexform

This repo is the delivery product only.

## What already exists
Vanilla HTML/JS + Netlify Functions + Supabase + Stripe + Twilio + Checkr.
Customer order, driver apply/portal, admin dispatch, GPS ping tables.

## What this branch adds
- `/status` rewrite documented next to `/driver` (was already pointing at the driver portal; kept explicit)
- `frontend/js/zones.js` — Port A / Padre / Mustang / Corpus hubs, vehicle classes, weather hold flags

## To go live this week
1. Netlify env: JWT, admin user, SUPABASE_*, STRIPE_*, TWILIO_*, GOOGLE_MAPS_API_KEY, FIREBASE_*
2. Run `schema.sql` on the Supabase project
3. Change admin password — README default is a finding
4. Do not collect SSN/bank in the public apply form until encrypted-at-rest is real
5. Wire `zones.js` into `order.js` pricing (replace the inline 4-row table)
6. Poll `get-driver-location` on `/track` every 15s and draw the last point on a map
7. Staff: one dispatcher on `/admin`, drivers on `/driver` with Go Online

Past apps to reference: `tommyphillips95/beach-brings` (stub), `tommyphillips95/beach-brings-app`, this repo.
