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
| `/apply/` (`js/apply.js`) | `POST /api/applications` (multipart when an insurance card is attached) | `submit-application` (JSON only) | File storage for the insurance card (e.g. a Supabase Storage bucket), and a decision on SSN/bank fields, which `submit-application` would store as plain text. Since the apply-honest-errors fix, the page only shows "submitted" after a confirmed save (2xx + `applicationId`); until this route exists applicants see "We couldn't submit your application right now. Please try again later or contact us." with their answers kept (SSN/bank numbers are never written to localStorage). |
| `/admin/` (`admin/admin.js`) and `/admin/checkr.html` login | `/api/admin/login`, `/api/admin/applications`, `/api/admin/applications/:id`, `/api/admin/applications/bulk` | `login-admin`, `get-applications`, `update-application` | Port the dashboard to the function contracts (paths, query params, response shapes), or add a small `admin` router function. Delete/bulk have no function at all. |
| `/driver/` documents | `POST /api/update-application/:id/documents` (multipart) | `update-application` (JSON `PUT`) | Same storage decision as the insurance card. |

When one of these is ported, remove it from `KNOWN_GAPS` in the test and from
this table. Once all are gone, delete `legacy/express-backend/`.
