# Coyote launch checklist

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
- Coastal Coyote UI (#22 / PR #23) is on this branch and live at https://coyote-dune-delivery.netlify.app

## Exact Netlify env vars (from `process.env` in `netlify/functions`)

| Name | Used by | Required | Secret |
|------|---------|----------|--------|
| `SITE_ORIGIN` | `_cors.js`, `dispatch.js`, `public-config.js`, `respond-offer.js` | Yes (CORS). Default fallback exists in some paths. | No |
| `SUPABASE_URL` | Most functions (orders, offers, applications, locations, webhooks) | Yes for any live booking | No (project URL) |
| `SUPABASE_SERVICE_KEY` | Same set as `SUPABASE_URL` | Yes | Yes |
| `JWT_SECRET` | `_auth.js`, `login-admin.js`, and authenticated admin/driver paths | Yes for admin + protected routes | Yes |
| `ADMIN_USERNAME` | `login-admin.js` | Yes for `/admin` login | Yes |
| `ADMIN_PASSWORD` | `login-admin.js` | Yes — rotate off any default | Yes |
| `STRIPE_SECRET_KEY` | `_stripe.js` | Yes for PaymentIntents | Yes |
| `STRIPE_PUBLISHABLE_KEY` | `public-config.js` (served to browser) | Yes for checkout UI | No (publishable) |
| `STRIPE_WEBHOOK_SECRET` | `_stripe.js` / payment webhook | Yes for webhook verify | Yes |
| `TWILIO_ACCOUNT_SID` | `create-order.js`, `dispatch.js`, `driver-sms-alert.js`, `send-sms.js`, `update-order.js` | Optional until SMS go-live (some paths soft-fail) | Yes |
| `TWILIO_AUTH_TOKEN` | Same Twilio set | Optional until SMS go-live | Yes |
| `TWILIO_PHONE_NUMBER` | Same Twilio set | Optional until SMS go-live | No |
| `CHECKR_API_KEY` | `checkr.js`, `checkr-create-candidate.js`, `checkr-initiate.js`, `checkr-refresh-report.js` | Optional until background checks | Yes |
| `CHECKR_WEBHOOK_SECRET` | `checkr-webhook.js` | Optional until Checkr webhooks | Yes |
| `CHECKR_PACKAGE` | `checkr-initiate.js` | Optional (code has default) | No |
| `FIREBASE_ADMIN_SDK_JSON` | `send-push-notification.js` | Optional (push only) | Yes |

Also set `NODE_VERSION=22` for builds (Netlify build/runtime). Template: root `.env.example`.

**Live Netlify check (2026-10-09):** production context on `coyote-dune-delivery` only has `SITE_ORIGIN` and `NODE_VERSION`. Payments, auth, and DB-backed booking stay dark until the required rows above are filled.

Webhook URL once Stripe is wired: `https://coyote-dune-delivery.netlify.app/api/payment-webhook`.

## SQL review

### Run order
1. `schema.sql` (base tables, indexes, RLS policies, triggers)
2. `schema/launch_2026_09_22.sql` (drop SSN/bank columns, add vehicle/weather fields, delete placeholder admin, tighten driver_locations policies)
3. `schema/dispatch_offers.sql` (auto-offer table + service-role-only RLS)

### Idempotency
- Tables/indexes/extensions: mostly `IF NOT EXISTS` — safe to re-run.
- `launch_2026_09_22.sql` and `dispatch_offers.sql`: `DROP … IF EXISTS` / `ADD COLUMN IF NOT EXISTS` — re-runnable.
- **Gap:** `schema.sql` `CREATE POLICY` statements are not preceded by `DROP POLICY IF EXISTS`, so a second full run of `schema.sql` errors on existing policies. Fresh project: fine. Re-apply on an existing DB: skip `schema.sql` or drop policies first.

### Destructive statements (flagged)
- `launch_2026_09_22.sql`: `ALTER TABLE applications DROP COLUMN IF EXISTS` for `ssn`, `bank_*` (intentional; Checkr + Stripe Connect hold that data).
- `launch_2026_09_22.sql`: `DELETE FROM admin_users WHERE username = 'admin'` (removes placeholder hash; use Netlify `ADMIN_*` only).
- No `TRUNCATE` / full-table `DROP TABLE`.

### RLS / policies
- Base schema enables RLS on applications, documents, customers, orders, related logs, FCM, analytics, driver_locations.
- Launch migration replaces public insert on `driver_locations` with a deny-insert policy (`WITH CHECK (false)`); service role bypasses RLS.
- `dispatch_offers` RLS allows no public access (`USING (false)` / `WITH CHECK (false)`); Netlify functions use the service key.

### SSN / bank
- `schema.sql` still *creates* SSN/bank columns for brand-new DBs.
- `launch_2026_09_22.sql` drops them immediately after. After the full three-file run, those columns are gone (verified on scratch Postgres).

### Rollback note
- Restore from a Supabase backup taken before step 2 if you need SSN/bank columns or the old `admin` row back.
- To undo `dispatch_offers` only: `DROP TABLE IF EXISTS dispatch_offers CASCADE;`.
- Policy-only rollback: re-apply the prior `driver_locations` policies from `schema.sql` after dropping the launch replacements.

### Dry run (scratch Postgres 17, 2026-10-09 CT)
- Fresh DB `coyote_scratch`: ran `schema.sql` → `launch_2026_09_22.sql` → `dispatch_offers.sql` — **all succeeded**.
- After launch migration: `applications` has **zero** `ssn` / `bank_*` columns.
- Re-running the full trio on the same DB: **fails** at first `CREATE POLICY` in `schema.sql` (expected; see idempotency gap). Launch + dispatch files alone re-run cleanly.

## PR #2 merge gate (Tommy)

Tick before merging `[dune] Launch v1` into `main`:

- [ ] Required Netlify env set on production: `SUPABASE_*`, `JWT_SECRET`, `ADMIN_USERNAME`, `ADMIN_PASSWORD`, `STRIPE_*`, `SITE_ORIGIN` (Twilio/Checkr/Firebase optional until those features go live)
- [ ] Three SQL files run in order on the live Supabase project (after a backup)
- [ ] Admin password is not the placeholder / old default
- [ ] `/apply` does not collect SSN or bank (Checkr + Stripe Connect)
- [ ] Smoke: quote Port A → Mustang still $35; create-order stores matching `estimated_price`
- [ ] Smoke: one dispatcher on `/admin`, two drivers on `/driver` with Go Online, paid test order with a 4x4 online
- [ ] CI green on `agent/grok/cdd-launch-v1`

## To go live this week (ops)
1. Fill the required Netlify env rows above (live site already has `SITE_ORIGIN` + `NODE_VERSION` only).
2. Run the three SQL files on Supabase in order.
3. Twilio A2P 10DLC, Stripe live keys, Checkr live, privacy + terms, insurance note when ready for real traffic.
