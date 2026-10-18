# Backend: Netlify Functions + Supabase (the only one)

Confirmed for issue #11 (Oct 2026):

- **Deploy:** `netlify.toml` publishes `frontend/` and serves `/api/*` from
  `netlify/functions/` (`/api/checkr/*` → `checkr`). The live site
  `coyote-dune-delivery.netlify.app` is a CLI deploy of exactly those two folders
  (`netlify deploy --prod --dir frontend --functions netlify/functions`).
- **Data:** Supabase (Postgres) through `@supabase/supabase-js` with the service
  key, server side only. There is no SQLite and no other database.
- **Auth/CORS/payments:** `_auth.js` (admin JWT, customer tracking JWT, fails
  closed without `JWT_SECRET`), `_cors.js` (`SITE_ORIGIN`), `_stripe.js`
  (amount always from `orders.estimated_price`).
- **Express:** the old Express + SQLite scaffold is quarantined in
  `legacy/express-backend/`. It never had a committed `server.js`/`database.js`,
  cannot start, and nothing deployable imports it (`tests/single-backend.test.js`).

## One order contract

`POST /api/create-order` is the only order-create function. It re-prices with
`zones.priceQuote`, stores `estimated_price`, and returns a customer tracking token.
`/api/submit-order` is kept for any old callers as a `netlify.toml` rewrite to the
same function, so there is one implementation and one response shape. Nothing in
`frontend/` calls it any more.

## Frontend → function map

| Frontend | Calls | Function |
|---|---|---|
| `/order/` (`order.js`, `stripe-payment.js`) | `create-order`, `get-orders`, `create-payment-intent`, `public-config` | same names |
| `/track/` | `get-orders`, `get-driver-location` | same names |
| `/driver/` | `get-status`, `update-application`, `update-driver-location`, `pending-offer`, `respond-offer` | same names |
| `/admin/checkr.html` | `/api/checkr/*` | `checkr` |
| `/admin/analytics.html` | `get-orders`, `get-applications` | same names |
| all pages | `log-analytics-event`, `send-push-notification` | same names |

## Express-era gaps (not routed yet; need Tommy's call)

These frontend calls were written for the Express server and have no matching
function, so they 404 in production today. `tests/single-backend.test.js` keeps
this list from growing.

| Frontend | Calls | Closest function | What's needed |
|---|---|---|---|
| `/apply/` (`js/apply.js`) | `POST /api/submit-application` (also `/api/applications` redirect) | `submit-application` | Live. Form no longer collects SSN or bank details (Checkr + Stripe Connect later). Insurance card file upload to Supabase Storage is still a follow-up if multipart is needed; JSON submit works today. Honest-errors: success only after 2xx + `applicationId`. |
| `/driver/` documents | `POST /api/update-application/:id/documents` (multipart) | `update-application` (JSON `PUT`) | Same storage decision as the insurance card. |

When one of these is ported, remove it from `KNOWN_GAPS` in the test and from
this table. Once all are gone, delete `legacy/express-backend/`.

## Admin router (#33)

`netlify/functions/admin.js` serves the dashboard contract under `/api/admin/*`
(via the `/api/*` catch-all). Every route except `login` requires an admin JWT.

| Route | Does |
|---|---|
| `POST /api/admin/login` | delegates to `login-admin` (Netlify `ADMIN_*` env) |
| `GET /api/admin/applications` | list, shaped for the dashboard (`name`, `admin_notes` = `notes`, beach fields) |
| `PUT /api/admin/applications/:id` | whitelist: `status`, `admin_notes`, `beach_permit_ok`, `beach_access_notes` |
| `POST /api/admin/applications/bulk` | `{ ids, status }` |
| `DELETE /api/admin/applications/:id` | refused (405); set status to `rejected` instead |
| `GET /api/admin/orders` | last 50 orders with `weather_hold` + global weather state; each order has `driver_name`, `allowed` next statuses and `driver_options` (approved drivers with `eligible`/`reason`) |
| `PUT /api/admin/orders/:id` | dispatcher change: `{ driver_id }` assigns (status → `assigned`), `{ status }` moves along the map below, optional `note`; `cancelled` needs `confirm: true`. Rules in `_order-admin.js` (also used by `PATCH /api/update-order`) |
| `GET /api/admin/drivers` | approved drivers: `id`, `name`, `vehicle_class`, `online`, `beach_permit_ok` (no phone/email) |
| `PUT /api/admin/orders/:id/weather-hold` | `{ weather_hold: true\|false }`, logged to `order_status_logs` |
| `GET /api/admin/weather` | read-only `WEATHER_SHUTDOWN` state (the global gate stays Netlify env only) |

Order status map (admin): `pending → assigned | cancelled`, `assigned → in_progress | pending (unassign) | cancelled`, `in_progress → completed | cancelled`; `completed` and `cancelled` are closed. Payment state (`payment_status`, `final_price`, Stripe ids) is never set here; the Stripe webhook owns it, and a body carrying those fields gets 400. Drivers must be `approved`; a 4x4 order needs a `4x4`/`utv`/`awd` driver (same rule as auto-dispatch); offline or no-beach-permit drivers are allowed with a warning. Refusals are 4xx with a `code` (`invalid_transition`, `driver_ineligible`, `driver_not_approved`, `driver_not_found`, `driver_required`, `weather_hold`, `confirm_required`, `conflict`, `payment_fields_forbidden`, `invalid_status`). Every change writes `order_status_logs` (`changed_by: admin:<user>`, note `status from → to; driver …`), expires open auto-offers, and texts the assigned driver only when Twilio env is set (logged to `sms_logs` either way).

## Driver JWT (#6)

Driver portal login (`POST /api/get-status` with `applicantId` + `email`) returns a `token` JWT: `{ role: "driver", driver_id }`, signed with `JWT_SECRET` (7d). The portal stores it on `driver_session.token` and sends `Authorization: Bearer …` to:

- `GET /api/pending-offer`
- `POST /api/respond-offer` (`driver_id` comes from the token, not the body)
- `POST /api/update-driver-location`

`GET /api/get-driver-location` accepts admin JWT, the assigned driver JWT, or a customer tracking token scoped to that order (same mint path as `/api/get-orders`).

`POST /api/offer-next` and `/api/expire-offers` require admin JWT, header `x-internal-secret` matching env `INTERNAL_FUNCTION_SECRET`, or a Netlify schedule invocation (`x-netlify-event: schedule`). In-process callers still `require("./dispatch")` and skip HTTP auth.

Fails closed when `JWT_SECRET` is unset.
