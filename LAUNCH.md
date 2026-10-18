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

### Step 5 on Supabase: `order_idempotency.sql`
Run this once, after `orders` exists (steps 1–4). It is re-runnable: every statement is `IF NOT EXISTS`, so a second run makes no changes and raises no error. It only adds two nullable columns and one partial unique index, so no data is changed or deleted. Existing orders keep `NULL` in both columns.

1. Open the Supabase dashboard for the project, then go to **SQL Editor** and click **New query**.
2. Paste the full contents of `schema/order_idempotency.sql` (copied below, same text) and click **Run**. Expected result: "Success. No rows returned".

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

3. Verify it worked. In a new query, paste and run the query below. Expect one row with all three values `true`:

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

If any value is `false`, run step 2 again; it is safe to repeat. Until this is applied, `create-order` still creates orders, but without duplicate protection, and logs a warning. To undo it, use the rollback lines at the top of the file.

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

## PR #2 merge gate (Tommy)

Tick before merging `[dune] Launch v1` into `main`:

- [ ] Required Netlify env set on production: `SUPABASE_*`, `JWT_SECRET`, `ADMIN_USERNAME`, `ADMIN_PASSWORD`, `STRIPE_*`, `SITE_ORIGIN` (Twilio/Checkr/Firebase optional until those features go live)
- [ ] SQL files run in order (see Run order above) on the live Supabase project (after a backup)
- [ ] Admin password is not the placeholder / old default
- [ ] `/apply` does not collect SSN or bank (Checkr + Stripe Connect)
- [ ] Smoke: quote Port A → Mustang still $35; create-order stores matching `estimated_price`
- [ ] Smoke: one dispatcher on `/admin`, two drivers on `/driver` with Go Online, paid test order with a 4x4 online
- [ ] CI green on `agent/grok/cdd-launch-v1`

## To go live this week (ops)
1. Fill the required Netlify env rows above (live site already has `SITE_ORIGIN` + `NODE_VERSION` only).
2. Run the SQL files on Supabase in order (see Run order above).
3. Twilio A2P 10DLC, Stripe live keys, Checkr live, privacy + terms, insurance note when ready for real traffic.
