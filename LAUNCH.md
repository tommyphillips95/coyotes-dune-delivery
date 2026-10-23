# Coyote launch checklist

## Before the next production deploy
Production is deployed by hand with the Netlify CLI (the site is not linked to Git; live today is `main` @ 5e41c41). Whoever runs the next production deploy does these first:

Do them in one sitting, in this order, on the live Supabase project. **Take a backup first.** Steps 1–4 of the [Run order](#run-order) must already be applied (Step 5 needs the `orders` table). All SQL files are re-runnable.

1. **Step 5 (required): `schema/order_idempotency.sql`.** One order per checkout retry. [Paste, verify, undo](#step-5-on-supabase-order_idempotencysql).
2. **Step 6 (optional): `schema/customer_phone_normalize.sql`.** One customer per phone number. [Paste, verify, undo](#step-6-on-supabase-customer_phone_normalizesql). *If you skip this step:* `create-order` still works and matches common phone formats instead.
3. **Step 7 (required): `schema/vehicle_verification.sql`, then verify every beach driver's vehicle in admin** (**Applications** → **View** → **Vehicle Class (dispatch)** → **Save & mark verified**). **Without this, beach orders get no driver.** [Paste, verify, undo](#step-7-on-supabase-vehicle_verificationsql).
4. **Step 8 (required for consent records): `schema/driver_consents.sql`.** Keeps the four consent boxes and when they were accepted. [Paste, verify, undo](#step-8-on-supabase-driver_consentssql).
5. **Step 9 (recommended): `schema/admin_login_attempts.sql`.** Admin login lockout plus the per-IP limits; without it they're off and the functions log `admin_login_attempts table missing` / `rate limit is OFF`. [Paste, verify, undo](#step-9-on-supabase-admin_login_attemptssql).
6. **Storage bucket `driver-documents` for insurance cards:** **Public: off**, file size limit **4 MB**, types `image/jpeg, image/png, image/webp, image/heic, image/heif, application/pdf`. [Paste, verify, undo](#bucket-driver-documents).
7. **Check everything at once:** paste `schema/verify-schema.sql` into **SQL Editor** and **Run** (read-only). Every `REQUIRED` row must be `ok = true`; `optional` rows are steps 6 and 9.
8. **Then the production deploy.** The required [Netlify env vars](#exact-netlify-env-vars-from-processenv-in-netlifyfunctions) must be set first, since env changes apply on the next deploy. Deploy with the Netlify CLI from a clean checkout of the commit being released, with `npm test` passing. Merging a PR does **not** deploy. Then run the [Post-deploy smoke test](#post-deploy-smoke-test-after-each-production-deploy-15-min).

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
| `SITE_ORIGIN` | `_cors.js` (CORS allow-list), `_site-url.js` (links in texts: `dispatch.js`, `respond-offer.js`, `update-order.js`, `driver-sms-alert.js`; and `public-config.js`) | Yes (CORS). Comma-separated OK; links use the first valid `https://` origin, else `https://coyote-dune-delivery.netlify.app`. | No |
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
| `WEATHER_SHUTDOWN` | `create-order.js`, `dispatch.js` via `_weather.js` | Optional. Set `1`/`true` to pause new orders + offers | No |
| `WEATHER_SHUTDOWN_REASON` | `_weather.js` | Optional customer message during a hold | No |

Also set `NODE_VERSION=22` for builds (Netlify build/runtime). Template: root `.env.example`.

**Live Netlify check (2026-10-11 CT):** production context on `coyote-dune-delivery` still only has `SITE_ORIGIN` and `NODE_VERSION`. Payments, auth, and DB-backed booking stay dark until the required rows above are filled. Code-side security pass (#12 PRs #27–#29) is merged on this branch; remaining Tommy gate is issue #9 (rotate `ADMIN_PASSWORD` / `JWT_SECRET`, set Supabase + Stripe, add `ANTHROPIC_API_KEY` Actions secret).

Webhook URL once Stripe is wired: see [Stripe (card payments)](#stripe-card-payments) below.

## Stripe (card payments)
Card checkout stays off until `STRIPE_PUBLISHABLE_KEY` is set; without it, customers see "pay the driver". Do everything in **test mode** first.

### Env vars the code reads (Netlify)
| Name | Read by | Value |
|------|---------|-------|
| `STRIPE_SECRET_KEY` | `_stripe.js` (create-payment-intent, payment-webhook) | `sk_test_...` (later `sk_live_...`) |
| `STRIPE_PUBLISHABLE_KEY` | `public-config.js` (sent to the browser) | `pk_test_...` (later `pk_live_...`) |
| `STRIPE_WEBHOOK_SECRET` | `_stripe.js` `constructWebhookEvent` | `whsec_...` from the webhook endpoint (below) |

Set them in Netlify: **Site configuration → Environment variables → Add a variable**, scoped to **Functions** (the publishable key also only needs Functions, because the browser gets it from `/api/public-config`). Env changes only apply after the next deploy. Trigger one deploy after all three are set, so you use one build credit instead of three.

### Webhook endpoint
- **Endpoint URL:** `https://coyote-dune-delivery.netlify.app/.netlify/functions/payment-webhook`. That is the function `netlify/functions/payment-webhook.js`. `/api/payment-webhook` is the same function through the `/api/*` rewrite in `netlify.toml`; either works, but use the direct one. If a custom domain is added later, use that host.
- **Events to send.** Select exactly these. They are the event types `payment-webhook.js` handles; anything else is acknowledged and ignored.

<!-- stripe-webhook-events:start -->
- `payment_intent.succeeded`: marks the order `paid`, stores `final_price`, and starts driver dispatch
- `payment_intent.payment_failed`: marks the order `failed` (only for the order's current PaymentIntent)
- `payment_intent.requires_action`: keeps the order `pending` (3-D Secure in progress)
- `payment_intent.canceled`: marks the order `failed` (only for the order's current PaymentIntent)
- `charge.refunded`: a full refund marks the order `refunded`; a partial refund keeps it `paid` and adds a `partial_refund` row to `order_status_logs` with the running total
<!-- stripe-webhook-events:end -->

- **Signing secret:**
  1. In Stripe Dashboard (test mode on), go to **Developers → Webhooks → Add endpoint**.
  2. Paste the URL, select the five events, and save.
  3. On the endpoint page, under **Signing secret**, click **Reveal** and copy the `whsec_...` value into Netlify as `STRIPE_WEBHOOK_SECRET`.
  4. Test mode and live mode endpoints have **different** secrets. Create the live endpoint separately at go-live and replace the value.

### Test-mode checklist
Stripe test cards take any future expiry, any 3-digit CVC, and any ZIP.

1. **Keys:** Dashboard → toggle **Test mode** → Developers → API keys. Set `pk_test_...` and `sk_test_...` in Netlify, plus the test `whsec_...`, then deploy once.
2. **Successful card:** book an order on `/order/` and pay with `4242 4242 4242 4242`. Expect the "Payment Successful!" screen.
3. **3-D Secure:** new order, pay with `4000 0025 0000 3155`. Complete the test authentication pop-up; it should succeed. Repeat and click **Fail** in the pop-up; expect an error, and the card form stays so the customer can try again.
4. **Declined:** new order, pay with `4000 0000 0000 0002` (generic decline). Expect a decline message and no charge. The order shows `failed` until a retry succeeds. Retry on the same screen with `4242...`: it reuses the same PaymentIntent, and the order becomes `paid`.
5. **Retry after paying:** the checkout page removes the card form after success, so ask for the payment again from a terminal for the step-2 order. Copy its `id` from Supabase `orders`:
   ```bash
   curl -s -X POST https://coyote-dune-delivery.netlify.app/api/create-payment-intent \
     -H 'Content-Type: application/json' \
     -d '{"order_id":"<order id>","customer_email":"test@example.com"}'
   ```
   Expect HTTP 409 with `"code":"already_paid"`, which is what makes the checkout show the **Already Paid** screen (track button, no card form). No new payment should appear in Stripe. Both screens were rendered on the agent box with mocked responses (see the PR that added this section).
6. **Refund:** Dashboard → Payments → open the step-2 payment → **Refund**. Do a **partial** refund first, for example $10: the order stays `paid`, `order_status_logs` gets "Partial refund: $10.00 of $XX.XX refunded so far", and the track box shows "Paid (partly refunded)". Then refund the rest: the order becomes `refunded` ("Refund issued ... (full)"). Use **Resend** on the webhook delivery to confirm a repeat event adds no extra rows.
7. **What to check in the Stripe dashboard:**
   - **Payments:** one payment per paid order, with metadata `order_id` and `order_number`.
   - **Customers:** one customer per repeat customer, not one per payment (#52).
   - **Developers → Webhooks → endpoint → Event deliveries:** every event answered `200`. A `400` means the signing secret is wrong.
8. **What to check in Supabase** (Table Editor, read-only):
   - `orders` for each test order: `payment_status` (`paid` / `failed` / `refunded`), `final_price`, `stripe_payment_intent_id` and `stripe_customer_id` set.
   - `order_status_logs`: a "Payment succeeded via Stripe" row per paid order, and "Refund issued" after step 6. A row containing "WARNING" or "not marked paid" means investigate before go-live.

Go-live: repeat the endpoint and secret steps in live mode, swap the three env vars to live values, deploy once, and do one small real payment and refund.

## SQL review

### Run order
1. `schema.sql` (base tables, indexes, RLS policies, triggers)
2. `schema/launch_2026_09_22.sql` (drop legacy SSN/bank if present, add vehicle/weather fields, delete placeholder admin, tighten driver_locations policies)
3. `schema/dispatch_offers.sql` (auto-offer table + service-role-only RLS)
4. `schema/issue_13_constraints.sql` (beach permit flags + `last_location_at` heartbeat)
5. `schema/order_idempotency.sql` (`orders.idempotency_key` + partial unique index + `orders.idempotency_payload_hash`; `create-order` dedupes checkout retries on it, and creates orders normally with a log warning until this is applied). Exact steps: [Step 5 on Supabase](#step-5-on-supabase-order_idempotencysql).
6. *(Optional, NOT yet run anywhere)* `schema/customer_phone_normalize.sql`: adds `customers.phone_normalized` (10 US digits), a trigger to keep it in sync, a backfill, and a lookup index. The **unique** index is created only if no two customers share a number; otherwise the script skips it and prints a NOTICE. The script ends with a read-only report of duplicate numbers, and the same report can be pasted alone first as a pre-check. Merging duplicate customers is a **manual decision for Tommy**: `orders.customer_id` is `ON DELETE CASCADE`, so re-point orders before deleting anything. A suggested merge is included, commented out. `create-order` works with or without this column, and never writes it (the trigger does).
7. *(NOT yet run anywhere. **MUST be run, and your beach drivers verified in admin, BEFORE the production deploy** of this branch; see [Before the next production deploy](#before-the-next-production-deploy))* `schema/vehicle_verification.sql`: adds `applications.vehicle_class_reported`, `vehicle_class_verified_at`, `vehicle_class_verified_by` (all nullable, re-runnable, no data changed, nobody marked verified). Beach (4x4) orders now need a 4x4/AWD/UTV class that an admin verified, in auto-dispatch and admin assign alike. **Until this runs, no driver counts as verified, so beach orders get no driver**: auto-dispatch logs "No online 4x4 driver available. Holding for dispatch." plus a pointer to this step and admin assign refuses with a message pointing here. Mainland (2wd) orders are unaffected. Exact steps: [Step 7 on Supabase](#step-7-on-supabase-vehicle_verificationsql).
8. *(NOT yet run anywhere. Required for consent records, before the production deploy)* `schema/driver_consents.sql`: adds `applications.background_check_disclosure_read`, `esignature_consent`, `terms_consent` (boolean) and `consents_accepted_at` (timestamptz), all nullable; existing rows stay empty. `submit-application` stores all four consents plus the server time it accepted them. Until this runs, applications still save, without that record, and the function logs a warning. Exact steps: [Step 8 on Supabase](#step-8-on-supabase-driver_consentssql).
9. *(NOT yet run anywhere. Recommended before the production deploy)* `schema/admin_login_attempts.sql`: adds the `admin_login_attempts` table (service role only, RLS on, no policies). `login-admin` locks sign-in for 15 minutes after 5 failed tries from one IP or 20 for one username within 15 minutes; a successful sign-in clears the count and marks that IP as known (`ok:<ip>` row). For 90 days a known IP skips the per-username lock, so someone who only knows the username can't lock the real admin out; the per-IP lock still applies. Until this runs, login works without a limit and logs a warning. The same table also stores the public write limits, as `rl:<endpoint>:<ip>` rows with a 15-minute window per IP. The limits are `create-order` 30 new orders (an idempotent checkout retry is never counted), `submit-application` 20, and `log-analytics-event` 600. The order-number + phone lookup (`POST get-orders`) allows 60 per IP, and after 10 failed lookups that IP gets no more lookups for the rest of the window. A successful lookup doesn't reset that count. Track-page polling with a token is never limited. Over the limit, the endpoint returns 429 with `Retry-After`. Without the table those limits are off too (fail open). Exact steps: [Step 9 on Supabase](#step-9-on-supabase-admin_login_attemptssql).

All SQL below goes into Supabase → **SQL Editor** → **New query**. Every file is re-runnable and changes no existing rows except where noted. To copy a whole file from a checkout: `pbcopy < schema/<file>` (macOS) or open it on GitHub and use **Copy raw file**. After all of them, paste `schema/verify-schema.sql` for one read-only checklist of steps 5–9 and the bucket.

### Step 5 on Supabase: `order_idempotency.sql`
**Purpose:** `create-order` dedupes checkout retries on `orders.idempotency_key` (one order per checkout attempt). Without it orders still save, without duplicate protection, and the function logs a warning.

**Run:** Supabase → **SQL Editor** → **New query** → paste → **Run**. Expect "Success. No rows returned". Adds two nullable columns and one partial unique index; existing orders keep `NULL`.

```sql
-- One order per checkout attempt: create-order dedupes on orders.idempotency_key.
-- Safe to re-run. Run after schema/issue_13_constraints.sql.
-- Rollback: DROP INDEX IF EXISTS orders_idempotency_key_uidx;
--           ALTER TABLE orders DROP COLUMN IF EXISTS idempotency_payload_hash;
--           ALTER TABLE orders DROP COLUMN IF EXISTS idempotency_key;

ALTER TABLE orders ADD COLUMN IF NOT EXISTS idempotency_key TEXT;

-- Unique only when set, so old rows (NULL) and callers that send no key are unaffected.
CREATE UNIQUE INDEX IF NOT EXISTS orders_idempotency_key_uidx
    ON orders (idempotency_key)
    WHERE idempotency_key IS NOT NULL;

-- sha256 (hex) of the order-defining request fields, saved with the key. A
-- repeated key whose payload hash differs is refused (422) instead of replayed.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS idempotency_payload_hash TEXT;
```

**Verify:** one row, all three `true`.

```sql
SELECT
  EXISTS (SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'orders'
            AND column_name = 'idempotency_key' AND data_type = 'text') AS has_idempotency_key,
  EXISTS (SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'orders'
            AND column_name = 'idempotency_payload_hash' AND data_type = 'text') AS has_payload_hash,
  EXISTS (SELECT 1 FROM pg_indexes
          WHERE schemaname = 'public' AND tablename = 'orders'
            AND indexname = 'orders_idempotency_key_uidx'
            AND indexdef ILIKE 'CREATE UNIQUE INDEX%'
            AND indexdef ILIKE '%WHERE (idempotency_key IS NOT NULL)%') AS has_unique_index;
```

**Undo:** `DROP INDEX IF EXISTS orders_idempotency_key_uidx; ALTER TABLE orders DROP COLUMN IF EXISTS idempotency_payload_hash, DROP COLUMN IF EXISTS idempotency_key;`

### Step 6 on Supabase: `customer_phone_normalize.sql`
**Purpose (optional):** adds `customers.phone_normalized` (10 US digits) with a sync trigger, backfill and lookup index, so one phone maps to one customer. Without it `create-order` matches common phone formats and reuses the oldest customer row.

**Run:** **SQL Editor** → **New query** → paste the whole file `schema/customer_phone_normalize.sql` (135 lines, too long to repeat here) → **Run**. It updates only the new `phone_normalized` column. The last result is a duplicate-phone report: empty means the unique index was created. If it lists numbers, a NOTICE says the unique index was skipped; merging those customers is a manual decision ([Run order](#run-order) step 6), not part of this sitting.

**Verify:** one row, all `true` (`has_unique_index` is `false` only when duplicates held it back).

```sql
SELECT
  EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'customers' AND column_name = 'phone_normalized') AS has_column,
  EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'customers_phone_normalized_sync' AND NOT tgisinternal) AS has_trigger,
  EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'idx_customers_phone_normalized') AS has_lookup_index,
  EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'customers_phone_normalized_uidx') AS has_unique_index;
```

**Undo:** `DROP INDEX IF EXISTS customers_phone_normalized_uidx; DROP INDEX IF EXISTS idx_customers_phone_normalized; DROP TRIGGER IF EXISTS customers_phone_normalized_sync ON customers; DROP FUNCTION IF EXISTS customers_phone_normalized_sync(); ALTER TABLE customers DROP COLUMN IF EXISTS phone_normalized;`

### Step 7 on Supabase: `vehicle_verification.sql`
> **MUST be done BEFORE the production deploy**, together with the admin verification below. If production goes out first, no driver counts as verified, so **beach (4x4) orders get no driver**. Mainland orders are unaffected.

**Purpose:** beach (4x4) orders only go to drivers whose 4x4/AWD/UTV class an admin verified. Adds three nullable columns; nobody is marked verified.

**Run:** **SQL Editor** → **New query** → paste → **Run**. The last result lists approved drivers; every `vehicle_class_verified_at` is empty at first.

```sql
-- Vehicle class verification (draft; NOT run anywhere yet).
-- LAUNCH.md, SQL run order step 7.
--
-- Adds three nullable columns to applications. Re-runnable: every statement
-- is IF NOT EXISTS, so a second run changes nothing. No data is changed or
-- deleted, and no driver is marked verified by this script.
--
--   vehicle_class_reported     what the driver picked on the application form
--   vehicle_class_verified_at  when an admin checked the vehicle (NULL = not verified)
--   vehicle_class_verified_by  which admin checked it
--
-- After this runs, beach (4x4) orders only go to drivers whose 4x4/AWD/UTV
-- class has been verified in Admin > Applications > (driver) > Vehicle Class.
-- Before it runs, the app already treats every driver as unverified.

ALTER TABLE applications ADD COLUMN IF NOT EXISTS vehicle_class_reported TEXT;
ALTER TABLE applications ADD COLUMN IF NOT EXISTS vehicle_class_verified_at TIMESTAMPTZ;
ALTER TABLE applications ADD COLUMN IF NOT EXISTS vehicle_class_verified_by TEXT;

-- Read-only check (safe to run any time): approved drivers and their state.
SELECT id, first_name, last_name, status, vehicle_class, vehicle_class_reported,
       vehicle_class_verified_at, vehicle_class_verified_by
FROM applications
WHERE status = 'approved'
ORDER BY vehicle_class_verified_at NULLS FIRST, last_name;
```

**Then, in admin (Tommy):** for each approved driver who should get beach orders, check the vehicle yourself (photo / registration), then `SITE/admin/` → **Applications** → **View** → **Vehicle Class (dispatch)** → pick the class → **Save & mark verified**. Each change adds a dated line to the driver's Admin Notes. If a driver later edits make/model/year/plate in the driver portal, the verification clears and has to be redone.

**Verify:** one row, all `true`; then re-run the driver list above and expect `vehicle_class_verified_at` filled for your beach drivers.

```sql
SELECT
  EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'applications' AND column_name = 'vehicle_class_reported') AS has_reported,
  EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'applications' AND column_name = 'vehicle_class_verified_at') AS has_verified_at,
  EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'applications' AND column_name = 'vehicle_class_verified_by') AS has_verified_by;
```

**Undo:** `ALTER TABLE applications DROP COLUMN IF EXISTS vehicle_class_verified_by, DROP COLUMN IF EXISTS vehicle_class_verified_at, DROP COLUMN IF EXISTS vehicle_class_reported;` (everyone is unverified again).

### Step 8 on Supabase: `driver_consents.sql`
**Purpose:** `submit-application` stores all four consent boxes plus the server time it accepted them. Applications still save without it (the insert is retried without these columns and the function logs `consent columns missing`); only applications submitted after this runs have the record.

**Run:** **SQL Editor** → **New query** → paste → **Run**. Adds four nullable columns; existing rows stay empty.

```sql
-- Driver application consent records (draft; NOT run anywhere yet).
-- LAUNCH.md, SQL run order step 8.
--
-- Adds four nullable columns to applications. Strictly additive and
-- re-runnable: every statement is ADD COLUMN IF NOT EXISTS, so a second run
-- changes nothing. No data is changed or deleted; existing rows stay NULL.
--
--   background_check_disclosure_read  form box bgDisclosureRead ("I have read the disclosure")
--   esignature_consent                form box esignature (sign electronically)
--   terms_consent                     form box termsAgree (info confirmed + terms agreed)
--   consents_accepted_at              server time submit-application accepted all four
--
-- background_check_consent (form box bgConsent) already exists in schema.sql.
-- submit-application rejects an application unless all four boxes are ticked,
-- and saves applications without these columns (with a log warning) until
-- this file is run.

ALTER TABLE applications ADD COLUMN IF NOT EXISTS background_check_disclosure_read BOOLEAN;
ALTER TABLE applications ADD COLUMN IF NOT EXISTS esignature_consent BOOLEAN;
ALTER TABLE applications ADD COLUMN IF NOT EXISTS terms_consent BOOLEAN;
ALTER TABLE applications ADD COLUMN IF NOT EXISTS consents_accepted_at TIMESTAMPTZ;

-- Verify (read-only, safe any time): expect one row, all four values true.
SELECT
  EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'applications' AND column_name = 'background_check_disclosure_read' AND data_type = 'boolean' AND is_nullable = 'YES') AS has_disclosure_read,
  EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'applications' AND column_name = 'esignature_consent' AND data_type = 'boolean' AND is_nullable = 'YES') AS has_esignature,
  EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'applications' AND column_name = 'terms_consent' AND data_type = 'boolean' AND is_nullable = 'YES') AS has_terms,
  EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'applications' AND column_name = 'consents_accepted_at' AND data_type = 'timestamp with time zone' AND is_nullable = 'YES') AS has_accepted_at;
```

**Verify:** the file's last query (above) returns one row, all `true`. After the deploy, a test application in **Table Editor** → `applications` has `background_check_disclosure_read`, `esignature_consent`, `terms_consent` = `true` and `consents_accepted_at` filled.

**Undo:** `ALTER TABLE applications DROP COLUMN IF EXISTS consents_accepted_at, DROP COLUMN IF EXISTS terms_consent, DROP COLUMN IF EXISTS esignature_consent, DROP COLUMN IF EXISTS background_check_disclosure_read;`

### Step 9 on Supabase: `admin_login_attempts.sql`
**Purpose (recommended):** one table for the admin login lockout (5 failures per IP / 20 per username in 15 minutes) and the per-IP limits on `create-order`, `submit-application`, `log-analytics-event` and the order-number + phone lookup. Without it all of those run unlimited (fail open) and log a warning. Service role only: RLS on, no policies.

**Run:** **SQL Editor** → **New query** → paste → **Run**. Creates one empty table; touches nothing else.

```sql
-- Admin login rate limit / lockout (draft; NOT run anywhere yet).
-- LAUNCH.md, SQL run order step 9.
--
-- One row per counter: key = 'ip:<client ip>' or 'user:<username>'.
-- login-admin (netlify/functions/_login-limit.js) counts failed sign-ins in a
-- 15-minute window and sets locked_until for 15 minutes at 5 failures per IP
-- or 20 per username. A successful sign-in clears both rows.
-- It also upserts 'ok:<client ip>' (updated_at = last success); for 90 days
-- that IP skips the per-username lock (the per-IP lock still applies).
-- Until this runs, admin login still works with NO rate limit (timing-safe
-- password check only) and logs "admin_login_attempts table missing".
--
-- Strictly additive and re-runnable. Service role only: RLS on, no policies,
-- so the anon/public key can't read or write it.

CREATE TABLE IF NOT EXISTS admin_login_attempts (
  key             TEXT PRIMARY KEY,
  failures        INTEGER NOT NULL DEFAULT 0,
  first_failed_at TIMESTAMPTZ,
  locked_until    TIMESTAMPTZ,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE admin_login_attempts ENABLE ROW LEVEL SECURITY;

-- Verify (read-only, safe any time): expect one row, both values true.
SELECT
  EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'admin_login_attempts') AS has_table,
  COALESCE((SELECT relrowsecurity FROM pg_class WHERE oid = 'public.admin_login_attempts'::regclass), false) AS rls_on;
```

**Verify:** the file's last query (above) returns `has_table` and `rls_on` both `true`. Columns, primary key and "no policies" are checked row by row in `schema/verify-schema.sql` (step `9`). After the deploy, 5 wrong admin passwords in a row show "Too many failed sign-in attempts. Try again in 15 minutes."; to unlock early, delete the `ip:<your ip>` row in **Table Editor** → `admin_login_attempts`.

**Undo:** `DROP TABLE IF EXISTS admin_login_attempts;` (login and the per-IP limits run without a limit again).

### Bucket: `driver-documents`
**Purpose:** private Storage bucket where `submit-application` keeps each applicant's insurance card. Without it applications still save, but the card is dropped and the notes say to ask for it again.

**Run:** **SQL Editor** → **New query** → paste → **Run** (or, by hand: Storage → **New bucket** → `driver-documents`, **Public: off**, 4 MB, the six types below). Safe to re-run; it resets the bucket to these settings.

```sql
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('driver-documents', 'driver-documents', false, 4194304,
        ARRAY['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'application/pdf'])
ON CONFLICT (id) DO UPDATE
   SET public = false,
       file_size_limit = EXCLUDED.file_size_limit,
       allowed_mime_types = EXCLUDED.allowed_mime_types;
```

**Verify:** one row: `false`, `4194304`, the six types.

```sql
SELECT public, file_size_limit, allowed_mime_types FROM storage.buckets WHERE id = 'driver-documents';
```

**Undo** (only while the bucket is still empty): `DELETE FROM storage.buckets WHERE id = 'driver-documents';`

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
- `schema.sql` does **not** create SSN/bank columns (PR #28). Fresh DBs never get them.
- `launch_2026_09_22.sql` still drops legacy `ssn` / `bank_*` if an older DB has them, and removes the placeholder admin row.
- Admin/driver UI no longer shows or edits those fields (PR #29). Apply flow rejects them (PR #27).

### Rollback note
- Restore from a Supabase backup taken before step 2 if you need legacy SSN/bank columns or the old `admin` row back.
- To undo `dispatch_offers` only: `DROP TABLE IF EXISTS dispatch_offers CASCADE;`.
- Policy-only rollback: re-apply the prior `driver_locations` policies from `schema.sql` after dropping the launch replacements.

### Dry run (scratch Postgres 17, 2026-10-09 CT; reconfirmed against post-#28 schema on 2026-10-11)
- Fresh DB `coyote_scratch`: ran `schema.sql` → `launch_2026_09_22.sql` → `dispatch_offers.sql` — **all succeeded**.
- Fresh `schema.sql`: `applications` has **zero** `ssn` / `bank_*` columns (no create, no drop needed).
- Re-running the full trio on the same DB: **fails** at first `CREATE POLICY` in `schema.sql` (expected; see idempotency gap). Launch + dispatch files alone re-run cleanly.

## Driver insurance card uploads
The apply page sends the form as `multipart/form-data` with the insurance card (field `insuranceCard`). `submit-application` reads it (`netlify/functions/_multipart.js`), checks it (`_insurance-card.js`) and:
- accepts **JPG, PNG, WebP, HEIC/HEIF or PDF**, judged by the file's bytes, up to **4 MB** (Netlify's ~6 MB request limit, after base64). Too large → 413, wrong type → 415, missing → 400, each with a message the applicant sees. The page checks the same limits before sending.
- saves the application, then uploads the card to Storage bucket **`driver-documents`** at `applications/<application id>/insurance-card-<time>.<ext>` and adds a `documents` row (`file_type = insurance_card`, `storage_path`).
- if the upload fails (for example, the bucket is missing) the application is still saved, the response has `insuranceCardStored: false`, and the application's notes say "Insurance card upload failed … Ask the driver to send it again."

**Tommy, one-time setup:** see [Bucket: `driver-documents`](#bucket-driver-documents) (one SQL paste). Functions use `SUPABASE_SERVICE_KEY`, so no Storage policies are needed. No new env vars. Viewing the card: Storage → `driver-documents` → `applications/<id>/` (admin does not link to it yet).

## PR #2 merge gate (Tommy)

Tick before merging `[dune] Launch v1` into `main` (merged 2026-10-17). Merging into `main` does not deploy; production is deployed by hand. See [Before the next production deploy](#before-the-next-production-deploy).

- [ ] Required Netlify env set on production: `SUPABASE_*`, `JWT_SECRET`, `ADMIN_USERNAME`, `ADMIN_PASSWORD`, `STRIPE_*`, `SITE_ORIGIN` (Twilio/Checkr/Firebase optional until those features go live)
- [ ] SQL files run in order (see Run order above) on the live Supabase project (after a backup)
- [ ] **MUST, before the production deploy:** SQL step 7 (`schema/vehicle_verification.sql`) run **and** beach drivers verified in admin (**Save & mark verified**). Otherwise beach orders get no driver. See [Before the next production deploy](#before-the-next-production-deploy).
- [ ] SQL step 8 (`schema/driver_consents.sql`) run, so applications keep a consent record
- [ ] Storage bucket `driver-documents` (private) created for insurance cards
- [ ] Admin password is not the placeholder / old default
- [ ] `/apply` does not collect SSN or bank (Checkr + Stripe Connect)
- [ ] Smoke: quote Port A → Mustang still $35; create-order stores matching `estimated_price`
- [ ] Smoke: one dispatcher on `/admin`, two drivers on `/driver` with Go Online, paid test order with a 4x4 online
- [ ] CI green on `agent/grok/cdd-launch-v1`

## To go live this week (ops)
1. Fill the required Netlify env rows above (live site already has `SITE_ORIGIN` + `NODE_VERSION` only).
2. Run the SQL files on Supabase in order (see Run order above; the remaining steps are listed in [Before the next production deploy](#before-the-next-production-deploy)). **Step 7 (`schema/vehicle_verification.sql`) and verifying beach drivers in admin MUST be done BEFORE the production deploy**, or beach orders get no driver.
3. Twilio A2P 10DLC, Stripe live keys, Checkr live, privacy + terms, insurance note when ready for real traffic.
4. **TODO (Tommy): partner pickup addresses.** The home page "Order →" links open `/order/?restaurant=<slug>` and prefill the pickup address with just the partner *name* (no street addresses are in the code). Send the real street address (and confirm the town) for each, and they'll be added to `PARTNERS` in `frontend/js/coastal.js`:

   | Partner | Slug | Listed town | Pricing town used |
   |---|---|---|---|
   | TexMexCoyote | `texmexcoyote` | Port Aransas | Port Aransas |
   | H-E-B Coastal Market | `heb-coastal-market` | Corpus Christi | Corpus Christi |
   | Clem's Bait & Tackle | `clems-bait-tackle` | Port Aransas | Port Aransas |
   | Shells Seafood | `shells-seafood` | North Padre Island | **Padre Island** (mapped — confirm) |
   | Stingray's Taphouse | `stingrays-taphouse` | Port Aransas | Port Aransas |
   | Padre Island Burger Co. | `padre-island-burger-co` | North Padre Island | **Padre Island** (mapped — confirm) |

   North Padre Island (Corpus Christi ZIP 78418) is priced as the existing "Padre Island" zone (beach surcharge, 4x4). Pricing is by town name.
5. **Service-area checks (create-order, `netlify/functions/_service-area.js`).** Unknown towns and ZIPs outside 783xx/784xx are refused; an island-only ZIP (78373) with a mainland town is refused with a "pick Port Aransas or Mustang Island" message; 78418 (Flour Bluff mainland + North Padre/Mustang) with Corpus Christi is accepted at the quoted price but gets a 4x4 and an "Address check" note in the order log; other Coastal Bend ZIPs we haven't mapped (e.g. Fulton 78358, Aransas Pass 78336, Ingleside 78362) are accepted and flagged. **Tommy:** say if Fulton/Aransas Pass/Ingleside should become towns (they'd need a price-table entry) or be refused.

## Post-deploy smoke test (after each production deploy, ~15 min)

Run on a real phone against `https://coyote-dune-delivery.netlify.app` (`SITE=` below). Use test data only: your own phone number, a name like "Smoke Test", and Stripe **test mode**. Write down each order number (`CDD-…`) you create for the cleanup step. Console errors: iPhone → Safari Web Inspector on a Mac; Android → `chrome://inspect` on a desktop.

**Before you start:** one approved driver application for a test driver (your own phone). In `SITE/admin/` → **Applications** → **View** → **Vehicle Class (dispatch)**, pick **4x4 truck or SUV (4-wheel drive)** and tap **Save & mark verified** (needs [SQL step 7](#step-7-on-supabase-vehicle_verificationsql); before it runs the panel says so and the buttons are disabled). Expect "Verified: …, by <you> on …" and a new line in Admin Notes.

- [ ] **Old tracking links:** open `SITE/order/?track=CDD-TEST1`. Expect a 301 to `SITE/track/?order=CDD-TEST1` with the order number filled in. `SITE/order/?service=ride` should still open the order form (no redirect).
- [ ] **Pages load:** open `SITE/`, `SITE/order/`, `SITE/track/`. Each renders with no console errors. A `/favicon.ico` 404 means the site-icons change isn't deployed yet.
- [ ] **Pay Later order:** on `SITE/order/`, book Port Aransas → Mustang Island and tap **Place Order**. If the card form shows, tap **Pay Later**. Expect **Order Confirmed** with your `CDD-…` number, When / Pickup / Drop-off, "Estimated total … (pay your driver)" and **Track this order**.
- [ ] **78418:** new order, Corpus Christi, ZIP `78418`. Expect "Where is your pickup?" with **On Padre Island (beach)** / **Flour Bluff / mainland Corpus Christi**; the total updates when you choose. Pick island, place it (Pay Later). Admin later shows the zip-area note on that order.
- [ ] **Timeout / Retry:** fill an order, turn on airplane mode, tap **Place Order**. Expect "You're offline. Reconnect, then tap Retry. Nothing was charged." Turn airplane mode off and tap **Retry**: one order is created, not two (check admin).
- [ ] **Card payments:** run [Test-mode checklist](#test-mode-checklist) steps 2–5 (4242 success, 3-D Secure pass/fail, 4000 0000 0000 0002 decline then retry, already-paid retry → **Already Paid** screen). Skip until Stripe test keys are set.
- [ ] **Admin:** log in at `SITE/admin/`. Under **Orders & Weather Hold**, the declined-card order (or any flagged one) shows the "⚠ … need attention" banner and its flag.
- [ ] **Assign + status:** on the 78418 island order, pick the 4x4 test driver and tap **Assign**. Expect status **Assigned**, the driver name, and a history line "Admin <you>: status pending → assigned; driver … (4x4)." Then tap **Mark in progress** and **Mark completed**; each adds a "status … → …" history line. Any 2wd driver, and any 4x4 driver marked "(unverified)", is disabled for this order ("needs a verified 4x4").
- [ ] **Customer tracking:** keep `SITE/track/?order=<that CDD-…>` open on the phone while doing the step above (refreshes every 15 s). Expect status Pending → Assigned → On the Way → Completed, and the driver card "Driver assigned" → "Driver on the way" → "Trip completed".
- [ ] **SMS (only once Twilio is configured):**
  - after Place Order, the customer phone gets "Your order CDD-… has been received. We'll assign a driver shortly. — Coyote's Dune Delivery"
  - the test driver gets "Coyote's Dune Delivery: dispatch assigned you CDD-… (…). Call dispatch if you can't take it." when you assign from admin
  - the customer phone gets "Your driver <first name> has been assigned to order CDD-…. Track: SITE/track/?order=CDD-… — Coyote's Dune Delivery" when you assign from admin (first name only, no driver phone, no token). Unassign and assign the same driver again: no second text. The admin toast says whether the customer was texted.
  - when a driver accepts an auto-offer (paid orders), the customer gets "… accepted CDD-…. Track: SITE/track/?order=CDD-… — Coyote's Dune Delivery". The link has no token: opening it on another phone asks for the order's phone number.
  - every send appears in Supabase `sms_logs`
- [ ] **Refunds:** [Test-mode checklist](#test-mode-checklist) step 6 on the paid 4242 order (partial, then full). Admin shows "Paid, partly refunded", then "Refunded".
- [ ] **Cleanup:** in admin, **Cancel order** on every test order still open (confirm the prompt). Paid test orders were refunded above. Stripe test-mode data never charges anyone. Note the test order numbers in the deploy notes so they aren't mistaken for real customers.
