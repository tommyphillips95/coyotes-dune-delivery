# Coyote's Dune Delivery 🌊🚚

A full-stack delivery driver recruitment and management platform with a coastal desert aesthetic. Built for connecting independent drivers with delivery opportunities across desert and coastal regions.

---

## 📋 Project Overview

Coyote's Dune Delivery is a modern web application that allows prospective delivery drivers to:
- **Apply online** with a multi-step application form
- **Check application status** using a unique Applicant ID
- **Track onboarding progress** through the admin dashboard

Administrators can:
- **Review and manage applications** via a secure admin dashboard
- **Update application statuses** (pending, approved, rejected, etc.)
- **Search and filter applicants** by status, name, or ID

---

## 🛠 Tech Stack

### Frontend
- **HTML5** semantic markup
- **CSS3** with custom properties (CSS variables) for the coastal theme
- **Vanilla JavaScript** (ES6+), no framework required
- **Responsive design** — mobile-first, works on all devices

### Backend (Local Development)
- **Node.js** v20+ runtime
- **Express.js** web framework
- **better-sqlite3** lightweight, synchronous SQLite driver
- **jsonwebtoken** for JWT authentication
- **cors** for cross-origin handling

### Backend (Serverless Deployment — Netlify Functions)
- **Netlify Functions** (AWS Lambda-compatible)
- **better-sqlite3** with `/tmp` database storage (see ⚠️ Production Note below)
- **jsonwebtoken** for JWT authentication

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

### 2. Environment Variables

Create a `.env` file in the project root:

```env
# Server
PORT=3000
NODE_ENV=development

# Database (local development)
DATABASE_PATH=./database/coyote-dune-delivery.db

# JWT
JWT_SECRET=your-super-secret-jwt-key-change-this-in-production
JWT_EXPIRES=24h

# Admin Credentials (change these!)
ADMIN_USERNAME=admin
ADMIN_PASSWORD=coyotedune2024
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
| `DATABASE_PATH` | `/tmp/coyote-dune-delivery.db` | Optional (default used) |

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
│  │  - status/index.html        │    │
│  │  - admin/                   │    │
│  │  - css/, js/, assets/      │    │
│  └─────────────────────────────┘    │
│  ┌─────────────────────────────┐    │
│  │  Netlify Functions            │    │
│  │  - submit-application.js  ← /api/submit-application │
│  │  - get-applications.js    ← /api/get-applications   │
│  │  - update-application.js  ← /api/update-application │
│  │  - login-admin.js         ← /api/login-admin       │
│  │  - get-status.js          ← /api/get-status        │
│  └─────────────────────────────┘    │
└─────────────────────────────────────┘
```

> ⚠️ **Production Note:** SQLite in `/tmp` is **ephemeral** on Netlify Functions — data resets on every cold start. For production, migrate to a **real cloud database** such as:
> - **Supabase** (PostgreSQL, free tier available)
> - **PlanetScale** (MySQL-compatible, free tier available)
> - **Neon** (Serverless PostgreSQL)
> - **MongoDB Atlas** (NoSQL, free tier available)
> - **CockroachDB Serverless** (distributed SQL)

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

## 📡 API Endpoints Reference

### Public Endpoints (No Auth Required)

| Method | Endpoint | Description | Params / Body |
|--------|----------|-------------|---------------|
| `POST` | `/api/submit-application` | Submit a new driver application | Full application JSON object |
| `GET` | `/api/get-status?applicantId=XXX` | Check application status | `applicantId` query param |

### Admin Endpoints (JWT Bearer Token Required)

| Method | Endpoint | Description | Auth |
|--------|----------|-------------|------|
| `POST` | `/api/login-admin` | Admin login, returns JWT | None |
| `GET` | `/api/get-applications` | List all applications | `Authorization: Bearer <token>` |
| `GET` | `/api/get-applications?status=pending` | Filter by status | `Authorization: Bearer <token>` |
| `GET` | `/api/get-applications?search=john` | Search by name/email/ID | `Authorization: Bearer <token>` |
| `PUT` | `/api/update-application` | Update application status | `Authorization: Bearer <token>` |

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
│   ├── status/
│   │   └── index.html         # Status checker page
│   ├── admin/
│   │   ├── index.html         # Admin login page
│   │   └── dashboard.html     # Admin dashboard
│   ├── css/
│   │   └── styles.css         # Coastal theme styles
│   ├── js/
│   │   ├── app.js             # Application form logic
│   │   ├── status.js          # Status checker logic
│   │   └── admin.js           # Admin dashboard logic
│   └── 404.html               # Custom 404 page
├── netlify/
│   └── functions/             # Serverless functions (deployed to Netlify)
│       ├── submit-application.js
│       ├── get-applications.js
│       ├── update-application.js
│       ├── login-admin.js
│       └── get-status.js
├── database/                  # SQLite database (local dev)
│   └── coyote-dune-delivery.db
├── netlify.toml               # Netlify deployment config
├── .env                       # Environment variables (NOT in git)
├── .gitignore                 # Git ignore rules
├── package.json               # Node dependencies
└── README.md                  # This file
```

---

## 🔮 Future Improvements & Roadmap

### Phase 1 — Near Term (0–3 months)

| Feature | Description |
|---------|-------------|
| **Stripe Connect Payouts** | Integrate Stripe Connect to pay drivers directly. Onboard drivers as Stripe Connect recipients, automate weekly payouts based on completed deliveries. |
| **Real Background Check API** | Replace mock background checks with a real provider like **Checkr** or **Sterling**. Automate the check trigger on application submission and surface results in the admin dashboard. |
| **SMS Notifications** | Add **Twilio** integration to send drivers SMS updates when their application status changes (e.g., "Your application has been approved!"). |
| **Email via SendGrid / Nodemailer** | Send branded confirmation emails on application submission, status updates, and onboarding instructions using **SendGrid** or **Nodemailer** with SMTP. |
| **Cloud Database Migration** | Migrate from SQLite to **Supabase** (PostgreSQL) or **PlanetScale** for persistent, scalable data storage in serverless environments. |

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
| **Analytics Dashboard** | Add charts and KPIs for admins: driver retention, average delivery time, revenue per driver, etc. |
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

---

## 📄 License

This project is proprietary and confidential. Unauthorized distribution or use is prohibited.

---

## 🤝 Support

For questions or support, contact the development team or open an issue in the project repository.

---

**Built with 💙 by the Coyote's Dune Delivery Team**
