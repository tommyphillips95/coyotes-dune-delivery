# Coyote launch — separate from Nexform

This repo is the delivery product only.

## What already exists
Vanilla HTML/JS + Netlify Functions + Supabase + Stripe + Twilio + Checkr.
Customer order, driver apply/portal, admin dispatch, GPS ping tables.

## This branch (`agent/grok/cdd-launch-v1`)
- `CoyoteZones.priceQuote` is the dollar source of truth (`frontend/js/zones.js` + `netlify/functions/zones.js`)
- Order page loads `zones.js`; old `ZONE_DISTANCES` table is gone
- `/api/create-order` uses the same `priceQuote` — screen total == stored `estimated_price`
- Driver portal polls `/api/pending-offer` and Accept/Decline hits `/api/respond-offer` with a 90s countdown
- `/track` polls GPS every 15s; driver ping is 15s
- `tests/quote-parity.test.js` locks Port A → Mustang ($35) and Corpus in-town ($27)
- CORS helper locks origin via `SITE_ORIGIN`
- SQL: `schema.sql` then `schema/launch_2026_09_22.sql` then `schema/dispatch_offers.sql`

## To go live this week
1. Netlify env: JWT, ADMIN_USERNAME, ADMIN_PASSWORD, SUPABASE_*, STRIPE_*, TWILIO_*, SITE_ORIGIN, FIREBASE_*
2. Run `schema.sql` then `schema/launch_2026_09_22.sql` then `schema/dispatch_offers.sql` on the Supabase project
3. Change admin password in Netlify env — never commit it
4. Do not collect SSN/bank on `/apply` (Checkr + Stripe Connect)
5. Staff: one dispatcher on `/admin`, two drivers on `/driver` with Go Online
6. Dry-run a paid test order Port A → Mustang with a 4x4 driver online
7. Twilio A2P 10DLC, Stripe live, Checkr live, privacy + terms, insurance note

Past apps: `tommyphillips95/beach-brings` (stub), this repo.
