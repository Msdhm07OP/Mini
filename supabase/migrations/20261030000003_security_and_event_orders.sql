-- EventSync 3.0: application roles and digital event orders.
-- This migration is additive and keeps all existing scheduling tables intact.

CREATE TABLE IF NOT EXISTS user_profiles (
    user_id UUID PRIMARY KEY,
    role VARCHAR(20) NOT NULL DEFAULT 'client'
        CHECK (role IN ('admin', 'manager', 'staff', 'client')),
    client_id INTEGER REFERENCES clients(id) ON DELETE SET NULL,
    display_name VARCHAR(200),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_user_profiles_client_id ON user_profiles(client_id) WHERE client_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_user_profiles_role ON user_profiles(role);

ALTER TABLE idempotency_records ALTER COLUMN idempotency_key TYPE VARCHAR(320);

-- A digital Banquet/Event Order (BEO) is a living operational brief attached to a booking.
CREATE TABLE IF NOT EXISTS event_orders (
    id BIGSERIAL PRIMARY KEY,
    booking_id INTEGER NOT NULL UNIQUE REFERENCES bookings(id) ON DELETE CASCADE,
    status VARCHAR(20) NOT NULL DEFAULT 'draft'
        CHECK (status IN ('draft', 'ready', 'in_progress', 'completed')),
    setup_notes TEXT NOT NULL DEFAULT '',
    av_notes TEXT NOT NULL DEFAULT '',
    catering_notes TEXT NOT NULL DEFAULT '',
    accessibility_notes TEXT NOT NULL DEFAULT '',
    special_instructions TEXT NOT NULL DEFAULT '',
    run_of_show JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(run_of_show) = 'array'),
    setup_checklist JSONB NOT NULL DEFAULT '[
      {"id":"room_setup","label":"Room layout and seating prepared","done":false},
      {"id":"av_check","label":"Projectors and audio tested","done":false},
      {"id":"staff_briefing","label":"Support staff briefed","done":false},
      {"id":"client_ready","label":"Client arrival and access confirmed","done":false},
      {"id":"cleanup","label":"Cleanup and resource return completed","done":false}
    ]'::jsonb CHECK (jsonb_typeof(setup_checklist) = 'array'),
    version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
    last_updated_by UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_event_orders_status ON event_orders(status);

CREATE OR REPLACE FUNCTION set_event_order_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    NEW.updated_at := NOW();
    NEW.version := COALESCE(OLD.version, 0) + 1;
    RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_event_orders_updated_at ON event_orders;
CREATE TRIGGER trg_event_orders_updated_at
BEFORE UPDATE ON event_orders
FOR EACH ROW EXECUTE FUNCTION set_event_order_updated_at();

-- Create a draft BEO when a confirmed booking is created. Existing rows are backfilled below.
CREATE OR REPLACE FUNCTION ensure_event_order_for_confirmed_booking()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.status = 'confirmed' THEN
        INSERT INTO event_orders (booking_id) VALUES (NEW.id)
        ON CONFLICT (booking_id) DO NOTHING;
    END IF;
    RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_ensure_event_order ON bookings;
CREATE TRIGGER trg_ensure_event_order
AFTER INSERT OR UPDATE OF status ON bookings
FOR EACH ROW EXECUTE FUNCTION ensure_event_order_for_confirmed_booking();
INSERT INTO event_orders (booking_id)
SELECT id FROM bookings WHERE status = 'confirmed'
ON CONFLICT (booking_id) DO NOTHING;
