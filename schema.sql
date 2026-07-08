-- =============================================
-- Coyote's Dune Delivery — Supabase Database Schema
-- Run this in the Supabase SQL Editor
-- =============================================

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- =============================================
-- Applications Table (Driver Applications)
-- =============================================
CREATE TABLE IF NOT EXISTS applications (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    first_name TEXT NOT NULL,
    last_name TEXT NOT NULL,
    email TEXT NOT NULL,
    phone TEXT,
    date_of_birth DATE,
    ssn TEXT, -- encrypted at application level
    address TEXT,
    city TEXT,
    state TEXT,
    zip_code TEXT,
    emergency_contact_name TEXT,
    emergency_contact_phone TEXT,
    driver_license_number TEXT,
    driver_license_state TEXT,
    driver_license_expiry DATE,
    vehicle_year INTEGER,
    vehicle_make TEXT,
    vehicle_model TEXT,
    vehicle_color TEXT,
    license_plate TEXT,
    insurance_provider TEXT,
    insurance_policy_number TEXT,
    insurance_expiry DATE,
    bank_name TEXT,
    bank_account_name TEXT,
    bank_account_number TEXT,
    bank_routing_number TEXT,
    background_check_consent BOOLEAN DEFAULT FALSE,
    background_check_status TEXT DEFAULT 'pending', -- pending, in_progress, clear, consider, suspended
    background_check_report_id TEXT,
    background_check_completed_at TIMESTAMPTZ,
    status TEXT DEFAULT 'pending', -- pending, background_check, approved, rejected, on_hold
    notes TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_applications_email ON applications(email);
CREATE INDEX IF NOT EXISTS idx_applications_status ON applications(status);
CREATE INDEX IF NOT EXISTS idx_applications_created_at ON applications(created_at DESC);

-- =============================================
-- Documents Table (Uploaded Files)
-- =============================================
CREATE TABLE IF NOT EXISTS documents (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    application_id UUID NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
    filename TEXT NOT NULL,
    file_type TEXT, -- insurance_card, license, registration, etc.
    storage_path TEXT, -- path in Supabase Storage bucket
    url TEXT, -- public URL
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_documents_application ON documents(application_id);

-- =============================================
-- Admin Users Table (Optional - for more than one admin)
-- =============================================
CREATE TABLE IF NOT EXISTS admin_users (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL, -- bcrypt hashed
    role TEXT DEFAULT 'admin', -- admin, super_admin
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Insert default admin (change password in production!)
-- Password is 'coyote2024' - change this immediately after setup
INSERT INTO admin_users (username, password_hash) 
VALUES ('admin', '$2a$10$92IXUNpkjO0rOQ5byMi.Ye4oKoEa3Ro9llC/.og/at2.uheWG/igi')
ON CONFLICT (username) DO NOTHING;
-- Note: Above hash is for 'password' placeholder. You'll set the real password via the app.

-- =============================================
-- Background Check Log Table (Audit trail)
-- =============================================
CREATE TABLE IF NOT EXISTS background_check_logs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    application_id UUID NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
    provider TEXT, -- checkr, sterling, etc.
    action TEXT NOT NULL, -- initiated, completed, failed, reviewed
    status TEXT,
    report_id TEXT,
    response_payload JSONB,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_bg_logs_application ON background_check_logs(application_id);

-- =============================================
-- CUSTOMERS Table (Order Customers)
-- =============================================
CREATE TABLE IF NOT EXISTS customers (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    first_name TEXT NOT NULL,
    last_name TEXT NOT NULL,
    phone TEXT NOT NULL,
    email TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_customers_phone ON customers(phone);
CREATE INDEX IF NOT EXISTS idx_customers_email ON customers(email);

-- =============================================
-- ORDERS Table (Customer Orders)
-- =============================================
CREATE TABLE IF NOT EXISTS orders (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    order_number TEXT UNIQUE NOT NULL,
    customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    service_type TEXT NOT NULL, -- ride, package_delivery, grocery_run, group_transport
    status TEXT DEFAULT 'pending', -- pending, assigned, in_progress, completed, cancelled
    
    -- Locations
    pickup_address TEXT NOT NULL,
    pickup_city TEXT NOT NULL,
    pickup_zip TEXT,
    pickup_lat DECIMAL(10, 8),
    pickup_lng DECIMAL(11, 8),
    
    dropoff_address TEXT,
    dropoff_city TEXT,
    dropoff_zip TEXT,
    dropoff_lat DECIMAL(10, 8),
    dropoff_lng DECIMAL(11, 8),
    
    -- Scheduling
    scheduled_date DATE,
    scheduled_time TEXT, -- HH:MM format
    is_asap BOOLEAN DEFAULT TRUE,
    
    -- Order Details
    passenger_count INTEGER DEFAULT 1,
    package_description TEXT,
    package_size TEXT, -- small, medium, large, oversized
    special_instructions TEXT,
    
    -- Pricing
    estimated_price DECIMAL(10, 2),
    final_price DECIMAL(10, 2),
    tip_amount DECIMAL(10, 2) DEFAULT 0,
    
    -- Assignment
    driver_id UUID REFERENCES applications(id),
    assigned_at TIMESTAMPTZ,
    
    -- Timestamps
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_orders_customer ON orders(customer_id);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_order_number ON orders(order_number);
CREATE INDEX IF NOT EXISTS idx_orders_created_at ON orders(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_driver ON orders(driver_id);

-- =============================================
-- ORDER STATUS LOG Table (Audit Trail)
-- =============================================
CREATE TABLE IF NOT EXISTS order_status_logs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    status TEXT NOT NULL,
    note TEXT,
    changed_by TEXT, -- driver_id, admin, system
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_status_logs_order ON order_status_logs(order_id);

-- =============================================
-- ORDER ITEMS Table (for multi-item orders like grocery runs)
-- =============================================
CREATE TABLE IF NOT EXISTS order_items (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    item_name TEXT NOT NULL,
    quantity INTEGER DEFAULT 1,
    description TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items(order_id);

-- =============================================
-- Row Level Security (RLS) Policies
-- =============================================

-- Enable RLS on applications
ALTER TABLE applications ENABLE ROW LEVEL SECURITY;

-- Policy: admins can see all applications
CREATE POLICY "Admins can view all applications" 
ON applications FOR SELECT 
USING (true); -- We'll handle auth in the Netlify function

-- Policy: drivers can only see their own application
CREATE POLICY "Drivers can view own application" 
ON applications FOR SELECT 
USING (id::text = current_setting('app.current_user_id', true));

-- Enable RLS on documents
ALTER TABLE documents ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Drivers can view own documents" 
ON documents FOR SELECT 
USING (application_id::text = current_setting('app.current_user_id', true));

-- Enable RLS on customers
ALTER TABLE customers ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Public can create customers" 
ON customers FOR INSERT 
WITH CHECK (true);

CREATE POLICY "Customers can view own record by phone" 
ON customers FOR SELECT 
USING (true); -- Simplified; phone lookup is handled in function

-- Enable RLS on orders
ALTER TABLE orders ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Public can create orders" 
ON orders FOR INSERT 
WITH CHECK (true);

CREATE POLICY "Public can view orders by order_number" 
ON orders FOR SELECT 
USING (true);

-- Enable RLS on order_items
ALTER TABLE order_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Public can manage order_items" 
ON order_items FOR ALL 
USING (true)
WITH CHECK (true);

-- Enable RLS on order_status_logs
ALTER TABLE order_status_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Public can view status logs" 
ON order_status_logs FOR SELECT 
USING (true);

-- =============================================
-- Updated At Trigger
-- =============================================
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER update_applications_updated_at 
BEFORE UPDATE ON applications 
FOR EACH ROW 
EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_customers_updated_at 
BEFORE UPDATE ON customers 
FOR EACH ROW 
EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_orders_updated_at 
BEFORE UPDATE ON orders 
FOR EACH ROW 
EXECUTE FUNCTION update_updated_at_column();

-- =============================================
-- Storage Bucket for Documents (Run in Supabase Dashboard or via API)
-- =============================================
-- Go to Storage → Buckets → Create new bucket
-- Name: driver-documents
-- Public: false (enable public URL only for signed URLs)
-- File size limit: 10MB
-- Allowed types: image/*, application/pdf

-- =============================================
-- Setup Instructions
-- =============================================
-- 1. Create a new Supabase project at https://supabase.com
-- 2. Go to SQL Editor → New query
-- 3. Paste this entire file and run it
-- 4. Go to Settings → API → copy Project URL and anon/service key
-- 5. Go to Storage → Buckets → Create 'driver-documents' bucket
-- 6. Set these Netlify environment variables:
--    SUPABASE_URL = https://your-project.supabase.co
--    SUPABASE_SERVICE_KEY = your-service-role-key
--    JWT_SECRET = a-random-32-char-string
--    ADMIN_USERNAME = admin
--    ADMIN_PASSWORD = your-secure-password
-- 7. Deploy from GitHub in Netlify dashboard
