-- Auto-offer tables. Run after schema.sql and launch_2026_09_22.sql.

CREATE TABLE IF NOT EXISTS dispatch_offers (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    driver_id UUID NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
    status TEXT DEFAULT 'offered',
    required_class TEXT,
    distance_mi DECIMAL(8, 2),
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    responded_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_dispatch_offers_order ON dispatch_offers(order_id);
CREATE INDEX IF NOT EXISTS idx_dispatch_offers_driver ON dispatch_offers(driver_id);
CREATE INDEX IF NOT EXISTS idx_dispatch_offers_status ON dispatch_offers(status);

ALTER TABLE dispatch_offers ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Public read dispatch offers" ON dispatch_offers;
CREATE POLICY "Service role owns dispatch offers"
ON dispatch_offers FOR ALL
USING (false)
WITH CHECK (false);
