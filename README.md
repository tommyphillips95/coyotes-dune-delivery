# Coyote's Dune Delivery 🌊🚚

A full-stack delivery driver recruitment and management platform with a coastal desert aesthetic. Built for connecting independent drivers with delivery opportunities across desert and coastal regions.

---

## 📋 Project Overview

Coyote's Dune Delivery is a modern web application that allows prospective delivery drivers to:
- **Apply online** with a multi-step application form
- **Check application status** using a unique Applicant ID
- **Track onboarding progress** through the admin dashboard

Customers can:
- **Book rides and deliveries** across the Texas Gulf Coast
- **Pay securely with Stripe** — cards, Apple Pay, Google Pay
- **Track orders** in real-time with order number lookup
- **Receive SMS notifications** for order updates

Administrators can:
- **Review and manage applications** via a secure admin dashboard
- **Update application statuses** (pending, approved, rejected, etc.)
- **Search and filter applicants** by status, name, or ID
- **Dispatch orders** to approved drivers and track deliveries
- **Send bulk SMS alerts** to all approved drivers about new orders
- **View analytics dashboard** with KPIs, conversion rates, and zone data

---

## 📊 Analytics & Tracking

This app integrates **Google Analytics 4 (GA4)** and **Firebase Analytics** for comprehensive event tracking across all user journeys.

### Setup

#### 1. Google Analytics 4

1. Go to [Google Analytics](https://analytics.google.com) and create a new property
2. Copy your **Measurement ID** (looks like `G-XXXXXXXXXX`)
3. In Netlify Dashboard → Site Settings → Environment Variables, add:
   - `GA4_MEASUREMENT_ID` = `G-XXXXXXXXXX`
4. The frontend pages already include the placeholder. To override dynamically, set `window.__GA4_ID__` before loading `analytics.js`

#### 2. Firebase Analytics

1. Go to [Firebase Console](https://console.firebase.google.com) and create a project
2. Add a web app and copy the config values
3. In Netlify environment variables, add:
   - `FIREBASE_API_KEY`
   - `FIREBASE_PROJECT_ID`
   - `FIREBASE_MESSAGING_SENDER_ID`
   - `FIREBASE_APP_ID`
   - `FIREBASE_MEASUREMENT_ID` (optional, can reuse GA4 ID)
4. The frontend pages already include the placeholder. To override dynamically, set `window.__FIREBASE_API_KEY__`, `window.__FIREBASE_PROJECT_ID__`, etc. before loading `firebase-analytics.js`

### Environment Variables

| Variable | Description | Required |
|----------|-------------|----------|
| `GA4_MEASUREMENT_ID` | Your GA4 Measurement ID (G-XXXXXXXXXX) | ✅ |
| `FIREBASE_API_KEY` | Firebase API key | Optional |
| `FIREBASE_PROJECT_ID` | Firebase project ID | Optional |
| `FIREBASE_MESSAGING_SENDER_ID` | Firebase messaging sender ID | Optional |
| `FIREBASE_APP_ID` | Firebase app ID | Optional |
| `FIREBASE_MEASUREMENT_ID` | Firebase Analytics measurement ID | Optional |

### Key Events Tracked

#### Customer Events
| Event | Trigger | Data |
|-------|---------|------|
| `order_submitted` | Customer submits order form | `service_type`, `estimated_price` |
| `purchase` | Order placed successfully | `value`, `currency`, `service_type` |
| `order_now_clicked` | "Order Now" CTA clicked | — |

#### Driver Application Events
| Event | Trigger | Data |
|-------|---------|------|
| `application_started` | Step 1 of apply form shown | `step`, `total_steps` |
| `application_step_progressed` | User advances to next step | `step`, `total_steps` |
| `application_submitted` | Application form submitted | `application_id` |
| `generate_lead` | Conversion tracking | `lead_type` |

#### Admin Events
| Event | Trigger | Data |
|-------|---------|------|
| `admin_login_success` | Admin logs in successfully | `admin_user` |
| `admin_login_failed` | Admin login fails | `admin_user` |
| `application_status_changed` | Status updated (single or bulk) | `application_id`, `new_status` |
| `background_check_initiated` | Status set to background_check | `application_id` |
| `analytics_dashboard_view` | Admin opens analytics page | — |

#### Driver Portal Events
| Event | Trigger | Data |
|-------|---------|------|
| `driver_login_success` | Driver logs into portal | `applicant_id` |
| `driver_login_failed` | Driver login fails | `applicant_id` |
| `driver_go_online` | Driver clicks "Go Online" | `applicant_id` |
| `driver_go_offline` | Driver clicks "Go Offline" | `applicant_id` |

### Server-Side Analytics

Events are also logged to the Supabase `analytics_events` table via the `logAnalyticsEvent()` helper. This provides:
- **Session tracking** — 30-minute session IDs shared between GA4 and Firebase
- **Offline resilience** — events are stored even when third-party trackers are blocked
- **Custom queries** — query by `event_name`, `session_id`, `user_id`, or `metadata` JSONB

The `analytics_events` table schema:
```sql
CREATE TABLE analytics_events (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    event_name TEXT NOT NULL,
    category TEXT DEFAULT 'general',
    user_id TEXT,
    session_id TEXT,
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT NOW()
);
```

---

## 🛠 Tech Stack

### Frontend
- **HTML5** semantic markup
- **CSS3** with custom properties (CSS variables) for the coastal theme
- **Vanilla JavaScript** (ES6+), no framework required
- **Stripe.js** for secure card payment processing
- **Responsive design** — mobile-first, works on all devices

### Backend (Local Development)
- **Node.js** v20+ runtime
- **Express.js** web framework
- **better-sqlite3** lightweight, synchronous SQLite driver
- **jsonwebtoken** for JWT authentication
- **cors** for cross-origin handling

### Backend (Serverless Deployment — Netlify Functions)
- **Netlify Functions** (AWS Lambda-compatible)
- **Supabase** (PostgreSQL) for persistent data storage
- **jsonwebtoken** for JWT authentication
- **Stripe** for payment processing (PaymentIntents + webhooks)
- **Twilio** for SMS notifications

### Deployment Targets
- **Netlify** — static site + serverless functions (recommended for frontend + API)
- **Render / Railway** — traditional Node.js backend hosting (alternative)

---

## 🚀 Local Development Setup

### Prerequisites
- Node.js v20+ and npm installed
- Git (optional, for cloning)

### 1. Install Dependencies

```bash
npm install
```

This installs:
- `express`
- `better-sqlite3`
- `jsonwebtoken`
- `cors`
- `dotenv`
- `nodemon` (dev dependency)
- `stripe` (for payment processing)
- `twilio` (for SMS notifications)

### 2. Environment Variables

Create a `.env` file in the project root:

```env
# Server
PORT=3000
NODE_ENV=development

# Database (local development)
DATABASE_PATH=./database/coyote-dune-delivery.db

# Supabase (production database)
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_KEY=your-service-role-key

# JWT
JWT_SECRET=your-super-secret-jwt-key-change-this-in-production
JWT_EXPIRES=24h

# Admin Credentials (change these!)
ADMIN_USERNAME=admin
ADMIN_PASSWORD=coyotedune2024

# Stripe (for payment processing — required for checkout)
STRIPE_SECRET_KEY=sk_test_...
STRIPE_PUBLISHABLE_KEY=pk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...

# Twilio (for SMS notifications — optional but recommended)
TWILIO_ACCOUNT_SID=your-twilio-account-sid
TWILIO_AUTH_TOKEN=your-twilio-auth-token
TWILIO_PHONE_NUMBER=+15551234567

# Analytics (optional but recommended)
GA4_MEASUREMENT_ID=G-XXXXXXXXXX
FIREBASE_API_KEY=your-firebase-api-key
FIREBASE_PROJECT_ID=your-firebase-project-id
```

> ⚠️ **Security:** Never commit `.env` files to version control. Use different credentials in production.

### 3. Initialize the Database

The database is auto-created on first run. Just start the server:

```bash
npm run dev
```

Or using the local Express server directly:

```bash
node backend/server.js
```

The SQLite database file will be created at the path specified in `DATABASE_PATH`.

### 4. Access the Application

| Page | URL |
|------|-----|
| Homepage | `http://localhost:3000` |
| Driver Application | `http://localhost:3000/apply` |
| Status Checker | `http://localhost:3000/status` |
| Admin Login | `http://localhost:3000/admin` |
| Admin Dashboard | `http://localhost:3000/admin/dashboard.html` |
| Book a Ride | `http://localhost:3000/order` |
| Driver Portal | `http://localhost:3000/driver` |
| Analytics Dashboard | `http://localhost:3000/admin/analytics.html` |

---

## ☁️ Deployment

### Option A: Netlify (Recommended — Full Stack)

Deploy both the static frontend and serverless API on Netlify.

#### Step 1: Install Netlify CLI

```bash
npm install -g netlify-cli
```

#### Step 2: Link Your Site

```bash
netlify login
netlify init
# Follow the prompts to connect to your Netlify site
```

#### Step 3: Set Environment Variables on Netlify

In the Netlify Dashboard → Site Settings → Environment Variables, add:

| Variable | Value | Required |
|----------|-------|----------|
| `JWT_SECRET` | A long random string (use `openssl rand -base64 32`) | ✅ |
| `ADMIN_USERNAME` | Your chosen admin username | ✅ |
| `ADMIN_PASSWORD` | Your chosen admin password | ✅ |
| `JWT_EXPIRES` | `24h` (or `7d`, etc.) | Optional |
| `SUPABASE_URL` | Your Supabase project URL | ✅ |
| `SUPABASE_SERVICE_KEY` | Your Supabase service role key | ✅ |
| `STRIPE_SECRET_KEY` | Your Stripe secret key (sk_live_... or sk_test_...) | ✅ |
| `STRIPE_PUBLISHABLE_KEY` | Your Stripe publishable key (pk_live_... or pk_test_...) | ✅ |
| `STRIPE_WEBHOOK_SECRET` | Your Stripe webhook endpoint secret (whsec_...) | ✅ |
| `TWILIO_ACCOUNT_SID` | Your Twilio Account SID | Optional |
| `TWILIO_AUTH_TOKEN` | Your Twilio Auth Token | Optional |
| `TWILIO_PHONE_NUMBER` | Your Twilio phone number (E.164 format) | Optional |
| `GA4_MEASUREMENT_ID` | Your GA4 Measurement ID (G-XXXXXXXXXX) | Optional |
| `FIREBASE_API_KEY` | Your Firebase API key | Optional |
| `FIREBASE_PROJECT_ID` | Your Firebase project ID | Optional |
| `FIREBASE_MESSAGING_SENDER_ID` | Your Firebase messaging sender ID | Optional |
| `FIREBASE_APP_ID` | Your Firebase app ID | Optional |
| `FIREBASE_VAPID_KEY` | Your Firebase VAPID key | Optional |

> 💡 **Stripe Setup:** Sign up at [stripe.com](https://www.stripe.com), get your API keys from the Dashboard → Developers → API keys. Use `pk_test_...` / `sk_test_...` for development, `pk_live_...` / `sk_live_...` for production. Set up a webhook endpoint pointing to `https://your-site.netlify.app/api/payment-webhook` and copy the webhook signing secret.

> 💡 **Twilio Setup:** Sign up at [twilio.com](https://www.twilio.com), get a free trial number, and add your credentials above. SMS notifications will be sent to customers on order creation, driver assignment, and order completion.

> 💡 **Analytics Setup:** Sign up at [Google Analytics](https://analytics.google.com) for GA4 and [Firebase Console](https://console.firebase.google.com) for Firebase Analytics. Add the respective IDs to your Netlify environment variables.

#### Step 4: Deploy

```bash
netlify deploy --prod
```

Or connect your GitHub repo to Netlify for **automatic deploys on every push**.

#### Netlify Deployment Architecture

```
┌─────────────────────────────────────┐
│           Netlify CDN               │
│  ┌─────────────────────────────┐    │
│  │  Static Files (frontend/)   │    │
│  │  - index.html               │    │
│  │  - apply/index.html         │    │
│  │  - order/index.html         │    │
│  │  - admin/                   │    │
│  │  - driver/                  │    │
│  │  - css/, js/, assets/      │    │
│  └─────────────────────────────┘    │
│  ┌─────────────────────────────┐    │
│  │  Netlify Functions            │    │
│  │  - submit-application.js  ← /api/submit-application │
│  │  - get-applications.js    ← /api/get-applications   │
│  │  - update-application.js  ← /api/update-application │
│  │  - login-admin.js         ← /api/login-admin       │
│  │  - get-status.js          ← /api/get-status        │
│  │  - create-order.js        ← /api/create-order      │
│  │  - submit-order.js        ← /api/submit-order      │
│  │  - get-orders.js          ← /api/get-orders        │
│  │  - update-order.js        ← /api/update-order      │
│  │  - create-payment-intent.js ← /api/create-payment-intent │
│  │  - payment-webhook.js     ← /api/payment-webhook   │
│  │  - send-sms.js            ← /api/send-sms          │
│  │  - driver-sms-alert.js    ← /api/driver-sms-alert  │
│  │  - checkr*.js             ← /api/checkr/*          │
│  │  - log-analytics-event.js ← /api/log-analytics-event │
│  └─────────────────────────────┘    │
└─────────────────────────────────────┘
```

> ⚠️ **Production Note:** The app uses **Supabase** (PostgreSQL) for persistent data storage. SQLite in `/tmp` is **ephemeral** on Netlify Functions — data resets on every cold start. Supabase provides persistent, scalable data storage in serverless environments.

---

### Option B: Render or Railway (Traditional Node Backend)

Use this if you prefer a persistent traditional backend with a separate frontend deployment.

#### Deploy Backend to Render

1. Go to [render.com](https://render.com) and create a new **Web Service**
2. Connect your GitHub repo
3. Configure:
   - **Build Command:** `npm install`
   - **Start Command:** `node backend/server.js`
   - **Environment:** Node
4. Add environment variables in the Render Dashboard (same as `.env` above)
5. Deploy — Render provides a persistent disk, so SQLite data persists

#### Deploy Backend to Railway

1. Go to [railway.app](https://railway.app) and create a new project
2. Connect your GitHub repo or deploy from CLI:
   ```bash
   npm install -g @railway/cli
   railway login
   railway init
   railway up
   ```
3. Add environment variables in the Railway Dashboard
4. Railway provides persistent storage for SQLite

#### Deploy Frontend Separately

After the backend is live:
1. Update the frontend JavaScript `API_BASE_URL` to point to your Render/Railway backend URL
2. Deploy the `frontend/` folder to **Netlify** (static only), **Vercel**, or **GitHub Pages**

---

## 🔐 Admin Login Credentials

### Default Credentials (Development)

| Field | Value |
|-------|-------|
| Username | `admin` |
| Password | `coyotedune2024` |

> ⚠️ **Change these immediately** in production by setting `ADMIN_USERNAME` and `ADMIN_PASSWORD` environment variables.

### How Admin Login Works

1. Admin navigates to `/admin` and enters credentials
2. The `login-admin` Netlify Function validates credentials and returns a **JWT token**
3. The token is stored in `localStorage` and sent with every subsequent admin API request
4. Token expires after 24 hours (configurable via `JWT_EXPIRES` env var)

---

## 💳 Stripe Payment Processing

The app integrates **Stripe** for secure customer payments. Here's how it works:

### Payment Flow

1. **Customer places an order** via `/order/` — the order is created in Supabase with `status: 'pending'` and `payment_status: 'pending'`
2. **Payment form appears** with Stripe Elements (card input, Apple Pay, Google Pay)
3. **Customer enters card details** and clicks "Pay Now"
4. **Frontend calls `/api/create-payment-intent`** — server creates a Stripe PaymentIntent and returns `client_secret`
5. **Frontend confirms payment** with `stripe.confirmCardPayment()` — Stripe processes the card
6. **Stripe sends webhook** to `/api/payment-webhook` — server updates order `payment_status` to `paid` or `failed`
7. **Success/failure screen** is shown to the customer

### Stripe Webhook Setup

1. Go to [Stripe Dashboard → Developers → Webhooks](https://dashboard.stripe.com/webhooks)
2. Click "Add endpoint"
3. Enter your endpoint URL: `https://coyotes-dune-delivery.netlify.app/api/payment-webhook`
4. Select these events to listen for:
   - `payment_intent.succeeded`
   - `payment_intent.payment_failed`
   - `payment_intent.canceled`
   - `charge.refunded`
5. Copy the **Signing secret** (starts with `whsec_...`)
6. Add it to Netlify environment variables as `STRIPE_WEBHOOK_SECRET`

### Testing Payments

Use Stripe's test card numbers:

| Card Number | Scenario |
|-------------|----------|
| `4242 4242 4242 4242` | Payment succeeds |
| `4000 0000 0000 0002` | Card declined |
| `4000 0000 0000 3220` | 3D Secure required |

Use any future expiry date, any 3-digit CVC, and any ZIP code.

### API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/create-payment-intent` | Creates a Stripe PaymentIntent for an order |
| `POST` | `/api/payment-webhook` | Receives Stripe webhook events |

### Environment Variables

| Variable | Description | Example |
|----------|-------------|---------|
| `STRIPE_SECRET_KEY` | Your Stripe secret key | `sk_test_...` or `sk_live_...` |
| `STRIPE_PUBLISHABLE_KEY` | Your Stripe publishable key | `pk_test_...` or `pk_live_...` |
| `STRIPE_WEBHOOK_SECRET` | Webhook endpoint signing secret | `whsec_...` |

---

## 📡 API Endpoints Reference

### Public Endpoints (No Auth Required)

| Method | Endpoint | Description | Params / Body |
|--------|----------|-------------|---------------|
| `POST` | `/api/submit-application` | Submit a new driver application | Full application JSON object |
| `GET` | `/api/get-status?applicantId=XXX` | Check application status | `applicantId` query param |
| `POST` | `/api/create-order` | Create a new customer order | Order details JSON |
| `POST` | `/api/submit-order` | Submit customer order (legacy) | Order details JSON |
| `GET` | `/api/get-orders` | Get orders by number or phone | `order_number` or `phone` query |
| `PATCH` | `/api/update-order` | Update order status | `{ id, status, driver_id }` |
| `POST` | `/api/create-payment-intent` | Create Stripe PaymentIntent | `{ order_id, amount, customer_email }` |
| `POST` | `/api/payment-webhook` | Stripe webhook receiver | Raw Stripe event body |
| `POST` | `/api/send-sms` | Send a single SMS | `{ to_phone, message_body, order_id }` |
| `POST` | `/api/driver-sms-alert` | Send bulk SMS to all approved drivers | `{ message, driver_portal_url, order_id }` |
| `POST` | `/api/log-analytics-event` | Log an analytics event server-side | `{ event_name, category, user_id, session_id, metadata }` |

### Admin Endpoints (JWT Bearer Token Required)

| Method | Endpoint | Description | Auth |
|--------|----------|-------------|------|
| `POST` | `/api/login-admin` | Admin login, returns JWT | None |
| `GET` | `/api/get-applications` | List all applications | `Authorization: Bearer <token>` |
| `GET` | `/api/get-applications?status=pending` | Filter by status | `Authorization: Bearer <token>` |
| `GET` | `/api/get-applications?search=john` | Search by name/email/ID | `Authorization: Bearer <token>` |
| `PUT` | `/api/update-application` | Update application status | `Authorization: Bearer <token>` |

### Example: Create Payment Intent

```bash
curl -X POST https://your-site.netlify.app/api/create-payment-intent \
  -H "Content-Type: application/json" \
  -d '{
    "order_id": "your-order-uuid",
    "amount": 25.50,
    "customer_email": "customer@example.com"
  }'
```

### Example: Submit Application

```bash
curl -X POST https://your-site.netlify.app/api/submit-application \
  -H "Content-Type: application/json" \
  -d '{
    "fullName": "John Doe",
    "email": "john@example.com",
    "phone": "555-123-4567",
    "address": "123 Desert Lane",
    "city": "Yuma",
    "state": "AZ",
    "zipCode": "85364",
    "vehicleYear": "2020",
    "vehicleMake": "Toyota",
    "vehicleModel": "Tacoma",
    "vehicleColor": "White",
    "licensePlate": "ABC1234",
    "driversLicenseNumber": "D12345678",
    "hasInsurance": true,
    "insuranceProvider": "Geico",
    "insurancePolicyNumber": "POL-123456",
    "hasLiftGate": false,
    "canLift50lbs": true,
    "availabilityDays": "monday,tuesday,wednesday,thursday,friday",
    "availabilityHours": "morning,afternoon",
    "preferredZones": "north_coastal,central_desert",
    "experienceYears": "1-2",
    "previousDeliveryExperience": "Amazon Flex driver for 1 year",
    "backgroundCheckConsent": true,
    "drugTestConsent": true,
    "termsAccepted": true
  }'
```

### Example: Admin Login

```bash
curl -X POST https://your-site.netlify.app/api/login-admin \
  -H "Content-Type: application/json" \
  -d '{"username": "admin", "password": "coyotedune2024"}'
```

### Example: Get Applications (Admin)

```bash
curl -X GET https://your-site.netlify.app/api/get-applications \
  -H "Authorization: Bearer YOUR_JWT_TOKEN_HERE"
```

### Example: Update Application Status

```bash
curl -X PUT https://your-site.netlify.app/api/update-application?applicantId=CDD-XXX \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_JWT_TOKEN_HERE" \
  -d '{"status": "approved", "notes": "Background check passed. Welcome to the team!"}'
```

### Example: Send SMS

```bash
curl -X POST https://your-site.netlify.app/api/send-sms \
  -H "Content-Type: application/json" \
  -d '{
    "to_phone": "+15551234567",
    "message_body": "Your order COY-20250712-1234 has been received. We'll assign a driver shortly.",
    "order_id": "your-order-uuid"
  }'
```

### Example: Send Driver Alert (Bulk SMS)

```bash
curl -X POST https://your-site.netlify.app/api/driver-sms-alert \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_ADMIN_JWT" \
  -d '{
    "message": "New order available! Log in to accept: https://coyotes-dune-delivery.netlify.app/driver/",
    "order_id": "your-order-uuid"
  }'
```

### Example: Log Analytics Event

```bash
curl -X POST https://your-site.netlify.app/api/log-analytics-event \
  -H "Content-Type: application/json" \
  -d '{
    "event_name": "order_submitted",
    "category": "order",
    "user_id": "customer_123",
    "session_id": "sess_1234567890",
    "metadata": {"service_type": "ride", "estimated_price": 25.50}
  }'
```

---

## 🗄 Database Schema

### Table: `applications`

| Column | Type | Notes |
|--------|------|-------|
| `id` | INTEGER | Primary key, auto-increment |
| `applicantId` | TEXT | Unique, e.g. `CDD-ABC123-DEF` |
| `fullName` | TEXT | Required |
| `email` | TEXT | Required, validated |
| `phone` | TEXT | Required, 10 digits |
| `address` | TEXT | Required |
| `city` | TEXT | Required |
| `state` | TEXT | Required |
| `zipCode` | TEXT | Required |
| `vehicleYear` | TEXT | Required |
| `vehicleMake` | TEXT | Required |
| `vehicleModel` | TEXT | Required |
| `vehicleColor` | TEXT | Required |
| `licensePlate` | TEXT | Required |
| `driversLicenseNumber` | TEXT | Required |
| `hasInsurance` | INTEGER | 0/1 boolean |
| `insuranceProvider` | TEXT | Optional |
| `insurancePolicyNumber` | TEXT | Optional |
| `hasLiftGate` | INTEGER | 0/1 boolean |
| `canLift50lbs` | INTEGER | 0/1 boolean |
| `availabilityDays` | TEXT | Comma-separated |
| `availabilityHours` | TEXT | Comma-separated |
| `preferredZones` | TEXT | Comma-separated |
| `experienceYears` | TEXT | Required |
| `previousDeliveryExperience` | TEXT | Optional |
| `backgroundCheckConsent` | INTEGER | 0/1 boolean, required |
| `drugTestConsent` | INTEGER | 0/1 boolean, required |
| `termsAccepted` | INTEGER | 0/1 boolean, required |
| `status` | TEXT | Default: `pending` |
| `notes` | TEXT | Optional, admin-only |
| `createdAt` | TEXT | ISO datetime |
| `updatedAt` | TEXT | ISO datetime |

### Table: `orders`

| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID | Primary key |
| `order_number` | TEXT | Unique, e.g. `CDD-ABC123-DEF` |
| `customer_id` | UUID | References `customers(id)` |
| `service_type` | TEXT | ride, package_delivery, grocery_run, group_transport |
| `status` | TEXT | Default: `pending` |
| `stripe_payment_intent_id` | TEXT | Stripe PaymentIntent ID |
| `stripe_customer_id` | TEXT | Stripe Customer ID |
| `payment_status` | TEXT | pending, paid, failed, refunded |
| `pickup_address` | TEXT | Required |
| `pickup_city` | TEXT | Required |
| `dropoff_address` | TEXT | Optional |
| `dropoff_city` | TEXT | Optional |
| `estimated_price` | DECIMAL | Auto-calculated |
| `final_price` | DECIMAL | Set on completion |
| `driver_id` | UUID | References `applications(id)` |
| `created_at` | TIMESTAMPTZ | Auto |
| `updated_at` | TIMESTAMPTZ | Auto |
| `completed_at` | TIMESTAMPTZ | Set on completion |

### Table: `customers`

| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID | Primary key |
| `first_name` | TEXT | Required |
| `last_name` | TEXT | Required |
| `phone` | TEXT | Required |
| `email` | TEXT | Optional |
| `stripe_customer_id` | TEXT | Stripe Customer ID for recurring payments |
| `created_at` | TIMESTAMPTZ | Auto |
| `updated_at` | TIMESTAMPTZ | Auto |

### Table: `sms_logs`

| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID | Primary key |
| `order_id` | UUID | References `orders(id)`, nullable |
| `phone_number` | TEXT | Required |
| `message` | TEXT | Required |
| `status` | TEXT | pending, sent, failed, delivered |
| `twilio_sid` | TEXT | Twilio message SID |
| `error` | TEXT | Error message if failed |
| `created_at` | TIMESTAMPTZ | Auto |

### Table: `analytics_events`

| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID | Primary key |
| `event_name` | TEXT | Required |
| `category` | TEXT | Default: `general` |
| `user_id` | TEXT | Optional |
| `session_id` | TEXT | Optional |
| `metadata` | JSONB | Default: `{}` |
| `created_at` | TIMESTAMPTZ | Auto |

### Status Enum Values

| Status | Description |
|--------|-------------|
| `pending` | Application received, awaiting review |
| `under_review` | Being reviewed by admin team |
| `approved` | Accepted, onboarding next |
| `rejected` | Not accepted at this time |
| `onboarding` | Documents and training in progress |
| `active` | Driver is active and receiving deliveries |
| `inactive` | Driver paused or deactivated |

---

## 📁 Project Structure

```
coyotes-dune-delivery/
├── backend/
│   └── server.js              # Express server (local dev only)
├── frontend/
│   ├── index.html             # Public homepage
│   ├── apply/
│   │   └── index.html         # Driver application form
│   ├── order/
│   │   └── index.html         # Customer order form (with Stripe payment)
│   ├── admin/
│   │   ├── index.html         # Admin login page
│   │   ├── admin.js           # Admin dashboard logic
│   │   ├── admin.css          # Admin dashboard styles
│   │   ├── checkr.html        # Background check management
│   │   └── analytics.html     # Analytics dashboard (NEW)
│   ├── driver/
│   │   └── index.html         # Driver portal
│   ├── css/
│   │   └── style.css          # Coastal theme styles
│   ├── js/
│   │   ├── main.js            # Shared utilities + order form tracking
│   │   ├── order.js           # Order form logic + tracking
│   │   ├── apply.js           # Driver application + tracking
│   │   ├── analytics.js       # GA4 integration (NEW)
│   │   ├── firebase-analytics.js # Firebase Analytics integration (NEW)
│   │   ├── stripe-payment.js  # Stripe payment integration
│   │   └── firebase-messaging.js # FCM push notifications
│   └── 404.html               # Custom 404 page
├── netlify/
│   └── functions/             # Serverless functions (deployed to Netlify)
│       ├── submit-application.js
│       ├── get-applications.js
│       ├── update-application.js
│       ├── login-admin.js
│       ├── get-status.js
│       ├── create-order.js
│       ├── submit-order.js
│       ├── get-orders.js
│       ├── update-order.js
│       ├── create-payment-intent.js
│       ├── payment-webhook.js
│       ├── send-sms.js
│       ├── driver-sms-alert.js
│       ├── checkr*.js
│       └── log-analytics-event.js
├── database/                  # SQLite database (local dev)
│   └── coyote-dune-delivery.db
├── netlify.toml               # Netlify deployment config
├── schema.sql                 # Supabase database schema
├── .env                       # Environment variables (NOT in git)
├── .gitignore                 # Git ignore rules
├── package.json               # Node dependencies
└── README.md                  # This file
```

---

## 💳 Stripe Payment Integration

### How It Works

1. Customer fills out the order form and clicks "Place Order"
2. Order is created in Supabase with `payment_status: 'pending'`
3. A secure payment form appears with Stripe Elements
4. Customer enters card details and confirms payment
5. Stripe processes the payment and sends a webhook
6. Order is updated to `payment_status: 'paid'`
7. Customer sees a success screen

### Customer Experience

- **Card input** is handled by Stripe Elements — your server never sees raw card numbers
- **Apple Pay / Google Pay** are automatically enabled via Stripe's automatic payment methods
- **"Pay Later" button** allows customers to skip online payment and pay the driver in person
- **Error handling** shows clear messages for declined cards, expired cards, etc.

### Payment Status Tracking

Orders have a `payment_status` field with these values:

| Status | Meaning |
|--------|---------|
| `pending` | Order created, awaiting payment |
| `paid` | Payment successfully processed |
| `failed` | Payment attempt failed |
| `refunded` | Payment was refunded |

---

## 📱 SMS Notifications (Twilio Integration)

The app automatically sends SMS notifications to customers at key points in the order lifecycle:

### Triggered SMS Events

| Event | Trigger | Message |
|-------|---------|---------|
| **Order Created** | `create-order.js` or `submit-order.js` | "Your order [ORDER-123] has been received. We'll assign a driver shortly." |
| **Driver Assigned** | `update-order.js` (status → `assigned`) | "Your driver [Name] is on the way! Track: [URL]" |
| **Order Completed** | `update-order.js` (status → `completed`) | "Your delivery is complete. Thanks for choosing Coyote's Dune Delivery!" |
| **Driver Alert** | `driver-sms-alert.js` (manual/admin) | "New order available! Log in to accept: [driver portal URL]" |

### Setup

1. Sign up at [twilio.com](https://www.twilio.com)
2. Get a free trial phone number (or buy a number)
3. Copy your **Account SID**, **Auth Token**, and **Phone Number**
4. Add them to Netlify environment variables (see Deployment section above)
5. Verify your customer's phone numbers in Twilio console (trial mode) or upgrade to paid account for unrestricted sending

### Manual SMS API

You can also send SMS manually via the `/api/send-sms` endpoint:

```bash
curl -X POST https://your-site.netlify.app/api/send-sms \
  -H "Content-Type: application/json" \
  -d '{
    "to_phone": "+15551234567",
    "message_body": "Hello from Coyote's Dune Delivery!",
    "order_id": "optional-order-uuid"
  }'
```

### Bulk Driver Alerts

Send SMS to all approved drivers with one API call:

```bash
curl -X POST https://your-site.netlify.app/api/driver-sms-alert \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_ADMIN_JWT" \
  -d '{
    "message": "New order available! Log in to accept: https://coyotes-dune-delivery.netlify.app/driver/",
    "order_id": "optional-order-uuid"
  }'
```

---

## 🔮 Future Improvements & Roadmap

### Phase 1 — Near Term (0–3 months)

| Feature | Description |
|---------|-------------|
| ✅ **Stripe Payment Processing** | Secure card payments with Stripe Elements, PaymentIntents, and webhooks. |
| ✅ **Analytics Dashboard** | GA4 + Firebase Analytics with server-side event logging and admin KPI dashboard. |
| **Stripe Connect Payouts** | Integrate Stripe Connect to pay drivers directly. Onboard drivers as Stripe Connect recipients, automate weekly payouts based on completed deliveries. |
| **Real Background Check API** | Replace mock background checks with a real provider like **Checkr** or **Sterling**. Automate the check trigger on application submission and surface results in the admin dashboard. |
| ✅ **SMS Notifications** | Add **Twilio** integration to send customers and drivers SMS updates. |
| **Email via SendGrid / Nodemailer** | Send branded confirmation emails on application submission, status updates, and onboarding instructions using **SendGrid** or **Nodemailer** with SMTP. |
| ✅ **Cloud Database Migration** | Migrate from SQLite to **Supabase** (PostgreSQL) for persistent, scalable data storage in serverless environments. |

### Phase 2 — Mid Term (3–6 months)

| Feature | Description |
|---------|-------------|
| **Real-Time Driver Tracking** | Implement GPS tracking for active drivers using **Mapbox** or **Google Maps API**. Show live driver positions on an admin dispatch map. |
| **Delivery Assignment System** | Build a dispatch interface where admins can assign delivery jobs to active drivers based on location, availability, and vehicle capacity. |
| **Driver Mobile App** | Progressive Web App (PWA) or native app for drivers to accept jobs, update delivery status, and navigate to destinations. |
| **Photo Upload for Documents** | Allow drivers to upload photos of their driver's license, insurance card, and vehicle registration during onboarding. Store in cloud storage (**AWS S3**, **Cloudinary**, **Supabase Storage**). |
| **Rating & Review System** | Customers and admins can rate drivers post-delivery. Build a reputation score visible to dispatchers. |

### Phase 3 — Long Term (6–12 months)

| Feature | Description |
|---------|-------------|
| **Route Optimization** | Integrate a route optimization engine (**OSRM**, **GraphHopper**, or **Google Routes API**) to suggest the most efficient delivery routes. |
| **Multi-Region Support** | Expand beyond the initial region with geofenced zones, regional admin accounts, and localized pricing. |
| **Analytics Dashboard v2** | Add charts and KPIs for admins: driver retention, average delivery time, revenue per driver, cohort analysis, etc. |
| **Automated Onboarding** | Self-service onboarding with document verification, training video completion tracking, and quiz-based certification. |
| **AI-Powered Dispatch** | Use machine learning to predict demand hotspots and proactively suggest driver positioning. |

---

## 🐛 Troubleshooting

### Issue: `better-sqlite3` fails to install

```bash
# On macOS, install build tools first
xcode-select --install

# On Ubuntu/Debian
sudo apt-get install build-essential

# On Windows, use Windows Build Tools or VS Build Tools
npm install --global windows-build-tools
```

### Issue: Database is read-only on Netlify

Netlify Functions run in a read-only filesystem except `/tmp`. The functions already use `/tmp` by default. For persistent storage, migrate to a cloud database.

### Issue: JWT token expires too quickly

Set the `JWT_EXPIRES` environment variable to a longer duration, e.g., `7d` for 7 days.

### Issue: CORS errors in the browser

The Netlify functions include CORS headers. If you're seeing CORS errors, ensure your frontend origin matches the `Access-Control-Allow-Origin` header (currently set to `*` for development).

### Issue: SMS not sending

1. Check that all three Twilio environment variables are set in Netlify
2. Verify your Twilio phone number is active and has credit
3. In trial mode, you must verify recipient phone numbers in the Twilio console
4. Check the Netlify function logs for error messages

### Issue: Stripe payments not working

1. Check that `STRIPE_SECRET_KEY`, `STRIPE_PUBLISHABLE_KEY`, and `STRIPE_WEBHOOK_SECRET` are set in Netlify
2. Verify you're using the correct keys (test vs live)
3. Check that the webhook endpoint URL is correct and the webhook secret matches
4. Check Netlify function logs for Stripe API errors
5. Ensure the `stripe` package is installed (`npm install stripe`)

### Issue: Payment form not showing

1. Check that `STRIPE_PUBLISHABLE_KEY` is set in the frontend. You can set it inline in `frontend/order/index.html` or via a Netlify environment variable injected at build time.
2. Check the browser console for JavaScript errors
3. Ensure Stripe.js is loading from `https://js.stripe.com/v3/`

### Issue: Analytics not tracking

1. Check that `GA4_MEASUREMENT_ID` is set in Netlify environment variables or inline in the HTML
2. Verify `analytics.js` and `firebase-analytics.js` are loading in the browser Network tab
3. Check browser console for `[Analytics] gtag not ready` or `[Firebase Analytics] Not ready` warnings
4. Ad blockers may block GA4 and Firebase — the `logAnalyticsEvent()` fallback still logs to Supabase
5. Check the Supabase `analytics_events` table for server-side events

---

## 📄 License

This project is proprietary and confidential. Unauthorized distribution or use is prohibited.

---

## 🤝 Support

For questions or support, contact the development team or open an issue in the project repository.

---

**Built with 💙 by the Coyote's Dune Delivery Team**
