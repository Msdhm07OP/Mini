-- EventSync — all-in-one Supabase database setup for a BRAND-NEW Supabase project.
-- Run this file once in Supabase Dashboard -> SQL Editor.
-- DO NOT run this on a database that already has EventSync tables or migrations applied.
-- Alternative: use `supabase db push` to apply the versioned migrations; never use both methods.
-- Supabase Auth must be enabled in the project.

BEGIN;



-- ============================================================================
-- BEGIN MIGRATION: 20261030000001_core_schema.sql
-- ============================================================================

-- EventSync 2.0 Initial Schema Migration
-- Migration: 001_initial_schema
-- Description: Core tables with proper constraints, indexes, and audit support


-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS "btree_gist";

-- =============================================================================
-- CORE ENTITIES
-- =============================================================================

-- Venues
CREATE TABLE venues (
    id SERIAL PRIMARY KEY,
    name VARCHAR(100) NOT NULL UNIQUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_venues_name ON venues(name);

-- Halls
CREATE TABLE halls (
    id SERIAL PRIMARY KEY,
    venue_id INTEGER NOT NULL REFERENCES venues(id) ON DELETE RESTRICT,
    name VARCHAR(50) NOT NULL,
    capacity INTEGER NOT NULL CHECK (capacity > 0),
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(venue_id, name)
);

CREATE INDEX idx_halls_venue ON halls(venue_id);
CREATE INDEX idx_halls_capacity ON halls(capacity);
CREATE INDEX idx_halls_active ON halls(is_active) WHERE is_active = true;

-- Resource Types (projectors, audio systems, support staff)
CREATE TABLE resource_types (
    id SERIAL PRIMARY KEY,
    name VARCHAR(50) NOT NULL UNIQUE,
    description TEXT,
    unit VARCHAR(20) NOT NULL DEFAULT 'units',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_resource_types_name ON resource_types(name);

-- Venue Resource Capacity
CREATE TABLE venue_resource_capacity (
    id SERIAL PRIMARY KEY,
    venue_id INTEGER NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
    resource_type_id INTEGER NOT NULL REFERENCES resource_types(id) ON DELETE RESTRICT,
    capacity INTEGER NOT NULL CHECK (capacity >= 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(venue_id, resource_type_id)
);

CREATE INDEX idx_venue_resources_venue ON venue_resource_capacity(venue_id);
CREATE INDEX idx_venue_resources_type ON venue_resource_capacity(resource_type_id);

-- Clients
CREATE TABLE clients (
    id SERIAL PRIMARY KEY,
    name VARCHAR(200) NOT NULL,
    email VARCHAR(255),
    phone VARCHAR(50),
    organization VARCHAR(200),
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_clients_name ON clients(name);
CREATE INDEX idx_clients_email ON clients(email) WHERE email IS NOT NULL;
CREATE INDEX idx_clients_active ON clients(is_active) WHERE is_active = true;

-- =============================================================================
-- BOOKINGS
-- =============================================================================

-- Booking Status Enum
CREATE TYPE booking_status AS ENUM ('confirmed', 'cancelled', 'rejected', 'waitlisted');

-- Bookings
CREATE TABLE bookings (
    id SERIAL PRIMARY KEY,
    uuid UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
    client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE RESTRICT,
    hall_id INTEGER REFERENCES halls(id) ON DELETE RESTRICT,
    venue_id INTEGER NOT NULL REFERENCES venues(id) ON DELETE RESTRICT,
    preferred_venue_id INTEGER REFERENCES venues(id) ON DELETE RESTRICT,

    -- Requested shared-resource demand (kept even when a request is rejected/waitlisted)
    projectors_requested INTEGER NOT NULL DEFAULT 0 CHECK (projectors_requested >= 0),
    audio_systems_requested INTEGER NOT NULL DEFAULT 0 CHECK (audio_systems_requested >= 0),
    staff_requested INTEGER NOT NULL DEFAULT 0 CHECK (staff_requested >= 0),

    -- Event details
    event_name VARCHAR(255) NOT NULL,
    event_date DATE NOT NULL,
    event_start TIME NOT NULL,
    event_end TIME NOT NULL,

    -- Reserved times (including 30-min buffers)
    reserved_start TIME NOT NULL,
    reserved_end TIME NOT NULL,

    attendees INTEGER NOT NULL CHECK (attendees > 0),

    -- Booking state
    status booking_status NOT NULL,
    rejection_reason TEXT,
    rejection_code VARCHAR(50),

    -- Audit fields
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_by VARCHAR(100),
    correlation_id UUID,
    series_id UUID,
    series_occurrence INTEGER CHECK (series_occurrence IS NULL OR series_occurrence > 0),
    series_total INTEGER CHECK (series_total IS NULL OR series_total > 0),

    -- Constraints
    CHECK (event_start < event_end),
    CHECK (reserved_start <= event_start),
    CHECK (reserved_end >= event_end),
    CHECK (
        (status = 'confirmed' AND hall_id IS NOT NULL AND rejection_reason IS NULL) OR
        (status = 'rejected' AND hall_id IS NULL AND rejection_reason IS NOT NULL) OR
        (status = 'waitlisted' AND hall_id IS NULL AND rejection_reason IS NOT NULL) OR
        (status = 'cancelled')
    )
);

-- Indexes for bookings
CREATE INDEX idx_bookings_client ON bookings(client_id);
CREATE INDEX idx_bookings_hall ON bookings(hall_id);
CREATE INDEX idx_bookings_venue ON bookings(venue_id);
CREATE INDEX idx_bookings_status ON bookings(status);
CREATE INDEX idx_bookings_date ON bookings(event_date);
CREATE INDEX idx_bookings_date_status ON bookings(event_date, status);
CREATE INDEX idx_bookings_venue_date_status ON bookings(venue_id, event_date, status);
CREATE INDEX idx_bookings_uuid ON bookings(uuid);
CREATE INDEX idx_bookings_correlation ON bookings(correlation_id) WHERE correlation_id IS NOT NULL;
CREATE INDEX idx_bookings_series ON bookings(series_id, series_occurrence) WHERE series_id IS NOT NULL;
CREATE INDEX idx_bookings_waitlist ON bookings(event_date, created_at, id) WHERE status = 'waitlisted';

-- CRITICAL: Exclusion constraint to prevent overlapping confirmed bookings in same hall
-- Using btree_gist extension for interval overlap detection
ALTER TABLE bookings
ADD CONSTRAINT no_overlapping_hall_bookings
EXCLUDE USING gist (
    hall_id WITH =,
    event_date WITH =,
    tsrange(
        (event_date + reserved_start)::timestamp,
        (event_date + reserved_end)::timestamp
    ) WITH &&
) WHERE (status = 'confirmed');

-- =============================================================================
-- RESOURCE ALLOCATIONS
-- =============================================================================

-- Booking Resource Allocations
CREATE TABLE booking_resource_allocations (
    id SERIAL PRIMARY KEY,
    booking_id INTEGER NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
    resource_type_id INTEGER NOT NULL REFERENCES resource_types(id) ON DELETE RESTRICT,
    quantity_allocated INTEGER NOT NULL CHECK (quantity_allocated >= 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(booking_id, resource_type_id)
);

CREATE INDEX idx_allocations_booking ON booking_resource_allocations(booking_id);
CREATE INDEX idx_allocations_resource ON booking_resource_allocations(resource_type_id);

-- =============================================================================
-- IDEMPOTENCY
-- =============================================================================

-- Idempotency records for preventing duplicate bookings
CREATE TABLE idempotency_records (
    id SERIAL PRIMARY KEY,
    idempotency_key VARCHAR(255) NOT NULL,
    request_hash TEXT NOT NULL,
    booking_id INTEGER REFERENCES bookings(id) ON DELETE SET NULL,
    response_data JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL,
    UNIQUE(idempotency_key)
);

CREATE INDEX idx_idempotency_key ON idempotency_records(idempotency_key);
CREATE INDEX idx_idempotency_expires ON idempotency_records(expires_at);

-- =============================================================================
-- AUDIT AND HISTORY
-- =============================================================================

-- Audit event types
CREATE TYPE audit_event_type AS ENUM (
    'booking_requested',
    'booking_confirmed',
    'booking_rejected',
    'booking_waitlisted',
    'waitlist_promoted',
    'booking_series_created',
    'booking_series_failed',
    'booking_cancelled',
    'booking_reschedule_attempted',
    'booking_reschedule_succeeded',
    'booking_reschedule_failed',
    'resource_allocated',
    'resource_released',
    'concurrency_conflict',
    'validation_failed'
);

-- Audit events
CREATE TABLE audit_events (
    id SERIAL PRIMARY KEY,
    event_id UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
    event_type audit_event_type NOT NULL,
    booking_id INTEGER REFERENCES bookings(id) ON DELETE SET NULL,
    client_id INTEGER REFERENCES clients(id) ON DELETE SET NULL,
    correlation_id UUID,
    actor VARCHAR(100),
    event_data JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_audit_booking ON audit_events(booking_id);
CREATE INDEX idx_audit_client ON audit_events(client_id);
CREATE INDEX idx_audit_type ON audit_events(event_type);
CREATE INDEX idx_audit_correlation ON audit_events(correlation_id) WHERE correlation_id IS NOT NULL;
CREATE INDEX idx_audit_created ON audit_events(created_at DESC);

-- Booking status history
CREATE TABLE booking_status_history (
    id SERIAL PRIMARY KEY,
    booking_id INTEGER NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
    from_status booking_status,
    to_status booking_status NOT NULL,
    reason TEXT,
    changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    changed_by VARCHAR(100)
);

CREATE INDEX idx_status_history_booking ON booking_status_history(booking_id);
CREATE INDEX idx_status_history_changed ON booking_status_history(changed_at DESC);

-- =============================================================================
-- FUNCTIONS AND TRIGGERS
-- =============================================================================

-- Update updated_at timestamp automatically
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Apply to relevant tables
CREATE TRIGGER update_venues_updated_at BEFORE UPDATE ON venues
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_halls_updated_at BEFORE UPDATE ON halls
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_venue_resources_updated_at BEFORE UPDATE ON venue_resource_capacity
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_clients_updated_at BEFORE UPDATE ON clients
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_bookings_updated_at BEFORE UPDATE ON bookings
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Audit trigger for booking status changes
CREATE OR REPLACE FUNCTION log_booking_status_change()
RETURNS TRIGGER AS $$
BEGIN
    IF (TG_OP = 'UPDATE' AND OLD.status IS DISTINCT FROM NEW.status) THEN
        INSERT INTO booking_status_history (booking_id, from_status, to_status, reason)
        VALUES (NEW.id, OLD.status, NEW.status, NEW.rejection_reason);
    ELSIF (TG_OP = 'INSERT') THEN
        INSERT INTO booking_status_history (booking_id, from_status, to_status, reason)
        VALUES (NEW.id, NULL, NEW.status, NEW.rejection_reason);
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER log_booking_status AFTER INSERT OR UPDATE ON bookings
    FOR EACH ROW EXECUTE FUNCTION log_booking_status_change();

-- Clean up expired idempotency records
CREATE OR REPLACE FUNCTION cleanup_expired_idempotency()
RETURNS void AS $$
BEGIN
    DELETE FROM idempotency_records WHERE expires_at < NOW();
END;
$$ LANGUAGE plpgsql;

-- =============================================================================
-- VIEWS FOR ANALYTICS
-- =============================================================================

-- Active bookings view
CREATE VIEW active_bookings AS
SELECT
    b.*,
    h.name as hall_name,
    h.capacity as hall_capacity,
    v.name as venue_name,
    c.name as client_name,
    c.organization as client_organization
FROM bookings b
JOIN venues v ON b.venue_id = v.id
JOIN clients c ON b.client_id = c.id
LEFT JOIN halls h ON b.hall_id = h.id
WHERE b.status = 'confirmed';

-- Resource utilization view: one row per resource/time segment, so overlapping
-- bookings are aggregated over the same interval instead of reporting each
-- booking's allocation as if it were the whole venue's utilization.
CREATE VIEW resource_utilization AS
WITH booking_resources AS (
    SELECT b.id AS booking_id,
           b.venue_id,
           b.event_date,
           b.reserved_start,
           b.reserved_end,
           bra.resource_type_id,
           bra.quantity_allocated
    FROM bookings b
    JOIN booking_resource_allocations bra ON bra.booking_id = b.id
    WHERE b.status = 'confirmed'
), time_points AS (
    SELECT venue_id, event_date, resource_type_id, reserved_start AS segment_time
    FROM booking_resources
    UNION
    SELECT venue_id, event_date, resource_type_id, reserved_end AS segment_time
    FROM booking_resources
), segments AS (
    SELECT venue_id, event_date, resource_type_id,
           segment_time AS segment_start,
           LEAD(segment_time) OVER (
             PARTITION BY venue_id, event_date, resource_type_id ORDER BY segment_time
           ) AS segment_end
    FROM time_points
), occupied AS (
    SELECT s.venue_id, s.event_date, s.resource_type_id,
           s.segment_start, s.segment_end,
           COALESCE(SUM(br.quantity_allocated), 0)::integer AS allocated_quantity
    FROM segments s
    LEFT JOIN booking_resources br
      ON br.venue_id = s.venue_id
     AND br.event_date = s.event_date
     AND br.resource_type_id = s.resource_type_id
     AND br.reserved_start < s.segment_end
     AND br.reserved_end > s.segment_start
    WHERE s.segment_end IS NOT NULL AND s.segment_start < s.segment_end
    GROUP BY s.venue_id, s.event_date, s.resource_type_id, s.segment_start, s.segment_end
)
SELECT v.id AS venue_id,
       v.name AS venue_name,
       rt.name AS resource_type,
       vrc.capacity AS total_capacity,
       o.event_date,
       o.segment_start AS reserved_start,
       o.segment_end AS reserved_end,
       o.allocated_quantity,
       vrc.capacity - o.allocated_quantity AS available_quantity,
       CASE WHEN vrc.capacity = 0 THEN 0
            ELSE ROUND((o.allocated_quantity::numeric / vrc.capacity) * 100, 2)
       END AS utilization_pct
FROM occupied o
JOIN venues v ON v.id = o.venue_id
JOIN resource_types rt ON rt.id = o.resource_type_id
JOIN venue_resource_capacity vrc
  ON vrc.venue_id = o.venue_id AND vrc.resource_type_id = o.resource_type_id;

-- END MIGRATION: 20261030000001_core_schema.sql


-- ============================================================================
-- BEGIN MIGRATION: 20261030000002_analytics_and_data_quality.sql
-- ============================================================================

-- 002_analytics_and_data_quality
--
-- Additive only: no table is dropped, altered destructively, or reset.
-- Everything here is a view or an index, so applying it to an existing
-- database cannot lose booking data.
--
-- Metric definitions are stated next to each view because the denominator is
-- the part that is usually wrong. "Utilisation" here always means reserved
-- time (including the 30-minute setup and cleanup buffers) divided by
-- available operating time, never a count of bookings.

-- ---------------------------------------------------------------------------
-- Indexes supporting the reporting queries below.
-- ---------------------------------------------------------------------------

-- Status-sliced reporting over a date range is the most common analytics scan.
CREATE INDEX IF NOT EXISTS idx_bookings_status_date
  ON bookings (status, event_date);

-- Rejection analysis filters on status and groups by reason.
CREATE INDEX IF NOT EXISTS idx_bookings_rejected_date
  ON bookings (event_date)
  WHERE status = 'rejected';

-- Lead-time and trend queries order by creation time.
CREATE INDEX IF NOT EXISTS idx_bookings_created_at
  ON bookings (created_at);

-- Allocation joins in the resource views.
CREATE INDEX IF NOT EXISTS idx_bra_booking
  ON booking_resource_allocations (booking_id, resource_type_id);

-- ---------------------------------------------------------------------------
-- v_booking_request_outcomes
--
-- One row per day per status. The denominator for every rate below is the
-- total number of REQUESTS recorded for that day, which includes rejected and
-- waitlisted requests — deliberately not the number of confirmed bookings.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_booking_request_outcomes AS
SELECT
  b.event_date,
  COUNT(*)                                                        AS requests,
  COUNT(*) FILTER (WHERE b.status = 'confirmed')                  AS confirmed,
  COUNT(*) FILTER (WHERE b.status = 'rejected')                   AS rejected,
  COUNT(*) FILTER (WHERE b.status = 'cancelled')                  AS cancelled,
  COUNT(*) FILTER (WHERE b.status = 'waitlisted')                 AS waitlisted,
  ROUND(100.0 * COUNT(*) FILTER (WHERE b.status = 'confirmed')
        / NULLIF(COUNT(*), 0), 2)                                 AS confirmation_rate_pct,
  ROUND(100.0 * COUNT(*) FILTER (WHERE b.status = 'rejected')
        / NULLIF(COUNT(*), 0), 2)                                 AS rejection_rate_pct
FROM bookings b
GROUP BY b.event_date;

-- ---------------------------------------------------------------------------
-- v_hall_utilisation
--
-- Numerator: total RESERVED minutes held in that hall on that date, with
-- overlapping intervals merged so no minute is ever counted twice. Confirmed
-- bookings should not overlap at all (the exclusion constraint forbids it),
-- but merging makes the metric robust rather than trusting that invariant.
--
-- Denominator: the operating window, 08:00-22:00 = 840 minutes per hall-day.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_hall_utilisation AS
WITH reserved AS (
  SELECT
    b.hall_id,
    b.venue_id,
    b.event_date,
    (b.event_date + b.reserved_start::time) AS starts_at,
    (b.event_date + b.reserved_end::time)   AS ends_at
  FROM bookings b
  WHERE b.status = 'confirmed'
),
-- Island-and-gap merge: a new island starts wherever a row begins after the
-- running maximum end time of all previous rows in the same hall-day.
marked AS (
  SELECT r.*,
         CASE WHEN r.starts_at > MAX(r.ends_at) OVER (
                PARTITION BY r.hall_id, r.event_date
                ORDER BY r.starts_at
                ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING)
              THEN 1 ELSE 0 END AS is_new_island
  FROM reserved r
),
islands AS (
  SELECT m.*, SUM(m.is_new_island) OVER (
           PARTITION BY m.hall_id, m.event_date ORDER BY m.starts_at) AS island_id
  FROM marked m
),
merged AS (
  SELECT hall_id, venue_id, event_date, island_id,
         MIN(starts_at) AS starts_at, MAX(ends_at) AS ends_at
  FROM islands
  GROUP BY hall_id, venue_id, event_date, island_id
)
SELECT
  h.id   AS hall_id,
  h.name AS hall_name,
  h.capacity,
  v.id   AS venue_id,
  v.name AS venue_name,
  m.event_date,
  SUM(EXTRACT(EPOCH FROM (m.ends_at - m.starts_at)) / 60)::numeric      AS reserved_minutes,
  840::numeric                                                          AS operating_minutes,
  ROUND(100.0 * SUM(EXTRACT(EPOCH FROM (m.ends_at - m.starts_at)) / 60)
        / 840.0, 2)                                                     AS utilisation_pct,
  ROUND(840.0 - SUM(EXTRACT(EPOCH FROM (m.ends_at - m.starts_at)) / 60), 2) AS unused_minutes
FROM merged m
JOIN halls h  ON h.id = m.hall_id
JOIN venues v ON v.id = m.venue_id
GROUP BY h.id, h.name, h.capacity, v.id, v.name, m.event_date;

-- ---------------------------------------------------------------------------
-- v_venue_utilisation
--
-- Venue utilisation is the merged reserved minutes across all of its halls
-- divided by (number of active halls x 840). Averaging hall percentages would
-- be wrong whenever halls differ in number across venues.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_venue_utilisation AS
SELECT
  u.venue_id,
  u.venue_name,
  u.event_date,
  SUM(u.reserved_minutes)                                   AS reserved_minutes,
  (SELECT COUNT(*) FROM halls h
    WHERE h.venue_id = u.venue_id AND h.is_active) * 840.0  AS available_minutes,
  ROUND(100.0 * SUM(u.reserved_minutes)
        / NULLIF((SELECT COUNT(*) FROM halls h
                   WHERE h.venue_id = u.venue_id AND h.is_active) * 840.0, 0), 2)
                                                            AS utilisation_pct
FROM v_hall_utilisation u
GROUP BY u.venue_id, u.venue_name, u.event_date;

-- ---------------------------------------------------------------------------
-- v_resource_peak_demand
--
-- Peak simultaneous demand per venue, date and resource type, computed with a
-- SQL sweep line: +q at each reserved_start, -q at each reserved_end, ordered
-- with ends before starts at equal timestamps so that back-to-back holds do
-- not produce a phantom spike. This mirrors the half-open interval semantics
-- used by the booking engine.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_resource_peak_demand AS
WITH events AS (
  SELECT b.venue_id, b.event_date, rt.id AS resource_type_id, rt.name AS resource_type,
         (b.event_date + b.reserved_start::time) AS at_time,
         bra.quantity_allocated AS delta,
         1 AS ordering
  FROM bookings b
  JOIN booking_resource_allocations bra ON bra.booking_id = b.id
  JOIN resource_types rt ON rt.id = bra.resource_type_id
  WHERE b.status = 'confirmed'
  UNION ALL
  SELECT b.venue_id, b.event_date, rt.id, rt.name,
         (b.event_date + b.reserved_end::time),
         -bra.quantity_allocated,
         0
  FROM bookings b
  JOIN booking_resource_allocations bra ON bra.booking_id = b.id
  JOIN resource_types rt ON rt.id = bra.resource_type_id
  WHERE b.status = 'confirmed'
),
running AS (
  SELECT e.*,
         SUM(e.delta) OVER (PARTITION BY e.venue_id, e.event_date, e.resource_type_id
                            ORDER BY e.at_time, e.ordering
                            ROWS UNBOUNDED PRECEDING) AS concurrent
  FROM events e
)
SELECT
  r.venue_id,
  v.name AS venue_name,
  r.event_date,
  r.resource_type,
  MAX(r.concurrent)                                           AS peak_concurrent,
  vrc.capacity                                                AS capacity,
  ROUND(100.0 * MAX(r.concurrent) / NULLIF(vrc.capacity, 0), 2) AS peak_utilisation_pct,
  GREATEST(vrc.capacity - MAX(r.concurrent), 0)               AS spare_at_peak
FROM running r
JOIN venues v ON v.id = r.venue_id
JOIN resource_types rt ON rt.name = r.resource_type
LEFT JOIN venue_resource_capacity vrc
       ON vrc.venue_id = r.venue_id AND vrc.resource_type_id = rt.id
GROUP BY r.venue_id, v.name, r.event_date, r.resource_type, vrc.capacity;

-- ---------------------------------------------------------------------------
-- v_demand_heatmap
--
-- Requests (all statuses) bucketed by weekday and start hour, so demand can be
-- read independently of whether it was satisfied. Separating demand from
-- confirmations is the point: a quiet hour on the confirmed-only view may
-- simply be an hour the system kept rejecting.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_demand_heatmap AS
SELECT
  EXTRACT(DOW  FROM b.event_date)::int         AS weekday,
  EXTRACT(HOUR FROM b.event_start::time)::int  AS start_hour,
  b.venue_id,
  COUNT(*)                                       AS requests,
  COUNT(*) FILTER (WHERE b.status = 'confirmed') AS confirmed,
  COUNT(*) FILTER (WHERE b.status = 'rejected')  AS rejected,
  ROUND(AVG(b.attendees), 1)                     AS avg_attendees
FROM bookings b
GROUP BY 1, 2, 3;

-- ---------------------------------------------------------------------------
-- v_rejection_analysis
--
-- Rejection reasons are free text, so they are bucketed into stable rule
-- classes here rather than grouped raw, which would scatter counts across
-- near-identical sentences.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_rejection_analysis AS
SELECT
  b.event_date,
  b.preferred_venue_id AS venue_id,
  CASE
    WHEN b.rejection_reason ILIKE '%operating hour%' THEN 'operating_hours'
    WHEN b.rejection_reason ILIKE '%capacity%'
      OR b.rejection_reason ILIKE '%seats%'
      OR b.rejection_reason ILIKE '%attendee%'                 THEN 'hall_capacity'
    WHEN b.rejection_reason ILIKE '%projector%'
      OR b.rejection_reason ILIKE '%audio%'
      OR b.rejection_reason ILIKE '%staff%'
      OR b.rejection_reason ILIKE '%resource%'                 THEN 'shared_resources'
    WHEN b.rejection_reason ILIKE '%hall%'
      OR b.rejection_reason ILIKE '%conflict%'
      OR b.rejection_reason ILIKE '%occupied%'                 THEN 'hall_conflict'
    ELSE 'other'
  END                                           AS rule_class,
  COUNT(*)                                      AS rejections,
  ROUND(AVG(b.attendees), 1)                    AS avg_attendees
FROM bookings b
WHERE b.status = 'rejected'
GROUP BY 1, 2, 3;

-- ---------------------------------------------------------------------------
-- v_lifecycle_trends
--
-- Cancellation and lead-time behaviour by the date the request was made.
-- Lead time is only meaningful for requests that were actually confirmed.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_lifecycle_trends AS
SELECT
  b.created_at::date                                           AS requested_on,
  COUNT(*)                                                     AS requests,
  COUNT(*) FILTER (WHERE b.status = 'cancelled')               AS cancellations,
  ROUND(100.0 * COUNT(*) FILTER (WHERE b.status = 'cancelled')
        / NULLIF(COUNT(*), 0), 2)                              AS cancellation_rate_pct,
  ROUND(AVG(b.event_date - b.created_at::date)
        FILTER (WHERE b.status = 'confirmed'), 1)              AS avg_lead_days_confirmed
FROM bookings b
GROUP BY 1;

-- ---------------------------------------------------------------------------
-- v_data_quality_findings
--
-- Read-only anomaly detection. This view never repairs anything; it reports.
-- Constraints prevent what can be prevented at write time, and this covers
-- what cannot — chiefly cross-row invariants.
--
-- Columns are uniform across every check so the API and CSV export can treat
-- findings as one list: check_name, severity, entity, entity_id, detail.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_data_quality_findings AS

-- A confirmed booking that holds no hall is not a booking.
SELECT 'confirmed_without_hall'::text AS check_name,
       'critical'::text               AS severity,
       'booking'::text                AS entity,
       b.id                           AS entity_id,
       format('Booking %s is confirmed but has no hall assigned.', b.id) AS detail,
       'Investigate the transaction that wrote this row; confirm or cancel it.'::text AS recommended_action
FROM bookings b
WHERE b.status = 'confirmed' AND b.hall_id IS NULL

UNION ALL
-- Resources still attached to a booking that no longer holds anything.
SELECT 'allocation_on_inactive_booking', 'critical', 'booking', b.id,
       format('Booking %s is %s but still holds %s resource allocation(s).',
              b.id, b.status, COUNT(bra.id)),
       'Release the allocations; cancelled and rejected requests must consume no capacity.'
FROM bookings b
JOIN booking_resource_allocations bra ON bra.booking_id = b.id
WHERE b.status IN ('cancelled', 'rejected')
GROUP BY b.id, b.status

UNION ALL
-- Allocation rows whose booking has disappeared.
SELECT 'orphaned_allocation', 'critical', 'allocation', bra.id,
       format('Allocation %s references booking %s, which does not exist.',
              bra.id, bra.booking_id),
       'Delete the orphaned allocation after confirming the booking is genuinely gone.'
FROM booking_resource_allocations bra
LEFT JOIN bookings b ON b.id = bra.booking_id
WHERE b.id IS NULL

UNION ALL
-- The sweep line must never find concurrent demand above venue capacity.
SELECT 'resource_capacity_exceeded', 'critical', 'venue', p.venue_id,
       format('%s at venue %s peaked at %s concurrent on %s against a capacity of %s.',
              p.resource_type, p.venue_id, p.peak_concurrent, p.event_date, p.capacity),
       'Audit the bookings overlapping that peak; one of them was written without a capacity check.'
FROM v_resource_peak_demand p
WHERE p.capacity IS NOT NULL AND p.peak_concurrent > p.capacity

UNION ALL
-- Intervals that are impossible rather than merely unusual.
SELECT 'invalid_interval', 'critical', 'booking', b.id,
       format('Booking %s runs %s to %s, which does not end after it starts.',
              b.id, b.event_start, b.event_end),
       'Correct the stored times; a CHECK constraint should prevent this.'
FROM bookings b
WHERE b.event_end <= b.event_start

UNION ALL
-- The reserved interval must be exactly the event plus both 30-minute buffers.
SELECT 'buffer_mismatch', 'warning', 'booking', b.id,
       format('Booking %s reserves %s-%s, which is not the event interval %s-%s widened by 30 minutes each side.',
              b.id, b.reserved_start, b.reserved_end, b.event_start, b.event_end),
       'Recompute the reserved interval; downstream utilisation metrics depend on it.'
FROM bookings b
WHERE b.status = 'confirmed'
  AND (b.reserved_start <> (b.event_start::time - interval '30 minutes')
    OR b.reserved_end   <> (b.event_end::time   + interval '30 minutes'))

UNION ALL
-- A confirmed hold outside operating hours should be impossible.
SELECT 'outside_operating_hours', 'critical', 'booking', b.id,
       format('Booking %s holds its hall %s-%s, outside 08:00-22:00.',
              b.id, b.reserved_start, b.reserved_end),
       'Cancel or reschedule; the allocation path that produced this skipped the hours check.'
FROM bookings b
WHERE b.status = 'confirmed'
  AND (b.reserved_start < time '08:00' OR b.reserved_end > time '22:00')

UNION ALL
-- Negative or absurd quantities.
SELECT 'invalid_resource_quantity', 'critical', 'allocation', bra.id,
       format('Allocation %s on booking %s has quantity %s.',
              bra.id, bra.booking_id, bra.quantity_allocated),
       'Quantities must be positive integers.'
FROM booking_resource_allocations bra
WHERE bra.quantity_allocated <= 0

UNION ALL
-- Every confirmed booking should carry a status-history trail.
SELECT 'missing_status_history', 'warning', 'booking', b.id,
       format('Booking %s has no status history rows.', b.id),
       'Audit history is incomplete for this booking; check the write path.'
FROM bookings b
WHERE NOT EXISTS (SELECT 1 FROM booking_status_history h WHERE h.booking_id = b.id)

UNION ALL
-- A rejected request with no explanation defeats decision visibility.
SELECT 'rejection_without_reason', 'warning', 'booking', b.id,
       format('Booking %s is rejected but stores no reason.', b.id),
       'Every refusal must record why; the client cannot otherwise be told.'
FROM bookings b
WHERE b.status = 'rejected'
  AND (b.rejection_reason IS NULL OR btrim(b.rejection_reason) = '');

-- END MIGRATION: 20261030000002_analytics_and_data_quality.sql


-- ============================================================================
-- BEGIN MIGRATION: 20261030000003_security_and_event_orders.sql
-- ============================================================================

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

-- END MIGRATION: 20261030000003_security_and_event_orders.sql


-- ============================================================================
-- BEGIN MIGRATION: 20261030000004_auth_rls_rpc.sql
-- ============================================================================

-- EventSync 3.0: Supabase identity, least-privilege RLS, and transactional RPC entry points.
-- Apply only after migrations 00001-00003. Existing browser/API clients must use a Supabase Auth JWT.

ALTER TABLE public.user_profiles
  ADD CONSTRAINT user_profiles_auth_user_fk
  FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;

CREATE OR REPLACE FUNCTION public.events_sync_touch_profile()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  INSERT INTO public.user_profiles (user_id, role, display_name)
  VALUES (
    NEW.id,
    'client',
    COALESCE(NEW.raw_user_meta_data ->> 'display_name', NEW.raw_user_meta_data ->> 'full_name', split_part(COALESCE(NEW.email, ''), '@', 1))
  )
  ON CONFLICT (user_id) DO UPDATE
    SET display_name = COALESCE(public.user_profiles.display_name, EXCLUDED.display_name),
        updated_at = NOW();
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS on_auth_user_created_events_sync ON auth.users;
CREATE TRIGGER on_auth_user_created_events_sync
AFTER INSERT ON auth.users
FOR EACH ROW EXECUTE FUNCTION public.events_sync_touch_profile();

CREATE OR REPLACE FUNCTION public.eventsync_role()
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT up.role FROM public.user_profiles up WHERE up.user_id = auth.uid()
$$;
CREATE OR REPLACE FUNCTION public.eventsync_is_staff()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT COALESCE(public.eventsync_role() IN ('admin', 'manager', 'staff'), false)
$$;
CREATE OR REPLACE FUNCTION public.eventsync_is_admin()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT COALESCE(public.eventsync_role() = 'admin', false)
$$;
CREATE OR REPLACE FUNCTION public.eventsync_client_id()
RETURNS integer LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT up.client_id FROM public.user_profiles up WHERE up.user_id = auth.uid()
$$;

-- Keep authorization helpers unavailable to anonymous callers. RLS policies execute as
-- the authenticated caller, so grant only the minimum helper execution they require.
REVOKE ALL ON FUNCTION public.eventsync_role() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.eventsync_is_staff() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.eventsync_is_admin() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.eventsync_client_id() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.eventsync_role() TO authenticated;
GRANT EXECUTE ON FUNCTION public.eventsync_is_staff() TO authenticated;
GRANT EXECUTE ON FUNCTION public.eventsync_is_admin() TO authenticated;
GRANT EXECUTE ON FUNCTION public.eventsync_client_id() TO authenticated;

-- RLS is a second boundary for direct Supabase Data API access. The Express API additionally
-- verifies tokens/roles; do not put a service-role key in the frontend.
ALTER TABLE public.user_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.venues ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.halls ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.resource_types ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.venue_resource_capacity ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.clients ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bookings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.booking_resource_allocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.idempotency_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.booking_status_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.event_orders ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS user_profiles_select_self_or_admin ON public.user_profiles;
CREATE POLICY user_profiles_select_self_or_admin ON public.user_profiles
  FOR SELECT TO authenticated USING (user_id = auth.uid() OR public.eventsync_is_admin());
DROP POLICY IF EXISTS user_profiles_admin_manage ON public.user_profiles;
CREATE POLICY user_profiles_admin_manage ON public.user_profiles
  FOR ALL TO authenticated USING (public.eventsync_is_admin()) WITH CHECK (public.eventsync_is_admin());

DROP POLICY IF EXISTS venues_read_authenticated ON public.venues;
CREATE POLICY venues_read_authenticated ON public.venues FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS venues_admin_write ON public.venues;
CREATE POLICY venues_admin_write ON public.venues FOR ALL TO authenticated USING (public.eventsync_is_admin()) WITH CHECK (public.eventsync_is_admin());

DROP POLICY IF EXISTS halls_read_authenticated ON public.halls;
CREATE POLICY halls_read_authenticated ON public.halls FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS halls_admin_write ON public.halls;
CREATE POLICY halls_admin_write ON public.halls FOR ALL TO authenticated USING (public.eventsync_is_admin()) WITH CHECK (public.eventsync_is_admin());

DROP POLICY IF EXISTS resource_types_read_authenticated ON public.resource_types;
CREATE POLICY resource_types_read_authenticated ON public.resource_types FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS resource_types_admin_write ON public.resource_types;
CREATE POLICY resource_types_admin_write ON public.resource_types FOR ALL TO authenticated USING (public.eventsync_is_admin()) WITH CHECK (public.eventsync_is_admin());

DROP POLICY IF EXISTS venue_resource_capacity_read_authenticated ON public.venue_resource_capacity;
CREATE POLICY venue_resource_capacity_read_authenticated ON public.venue_resource_capacity FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS venue_resource_capacity_admin_write ON public.venue_resource_capacity;
CREATE POLICY venue_resource_capacity_admin_write ON public.venue_resource_capacity FOR ALL TO authenticated USING (public.eventsync_is_admin()) WITH CHECK (public.eventsync_is_admin());

DROP POLICY IF EXISTS clients_staff_manage ON public.clients;
DROP POLICY IF EXISTS clients_manager_manage ON public.clients;
CREATE POLICY clients_manager_manage ON public.clients FOR ALL TO authenticated
  USING (public.eventsync_role() IN ('admin', 'manager'))
  WITH CHECK (public.eventsync_role() IN ('admin', 'manager'));
DROP POLICY IF EXISTS clients_read_self ON public.clients;
CREATE POLICY clients_read_self ON public.clients FOR SELECT TO authenticated USING (id = public.eventsync_client_id());

DROP POLICY IF EXISTS bookings_staff_read ON public.bookings;
CREATE POLICY bookings_staff_read ON public.bookings FOR SELECT TO authenticated USING (public.eventsync_is_staff());
DROP POLICY IF EXISTS bookings_client_read_own ON public.bookings;
CREATE POLICY bookings_client_read_own ON public.bookings FOR SELECT TO authenticated USING (client_id = public.eventsync_client_id());
-- Mutations must pass through the transactional RPC functions below; no direct table writes.
DROP POLICY IF EXISTS booking_allocations_staff_read ON public.booking_resource_allocations;
CREATE POLICY booking_allocations_staff_read ON public.booking_resource_allocations
  FOR SELECT TO authenticated USING (public.eventsync_is_staff());
DROP POLICY IF EXISTS booking_allocations_client_read_own ON public.booking_resource_allocations;
CREATE POLICY booking_allocations_client_read_own ON public.booking_resource_allocations
  FOR SELECT TO authenticated USING (EXISTS (
    SELECT 1 FROM public.bookings b WHERE b.id = booking_id AND b.client_id = public.eventsync_client_id()
  ));

DROP POLICY IF EXISTS audit_events_staff_read ON public.audit_events;
CREATE POLICY audit_events_staff_read ON public.audit_events FOR SELECT TO authenticated USING (public.eventsync_is_staff());
DROP POLICY IF EXISTS audit_events_client_read_own ON public.audit_events;
CREATE POLICY audit_events_client_read_own ON public.audit_events FOR SELECT TO authenticated USING (
  client_id = public.eventsync_client_id()
);
DROP POLICY IF EXISTS booking_history_staff_read ON public.booking_status_history;
CREATE POLICY booking_history_staff_read ON public.booking_status_history FOR SELECT TO authenticated USING (public.eventsync_is_staff());
DROP POLICY IF EXISTS booking_history_client_read_own ON public.booking_status_history;
CREATE POLICY booking_history_client_read_own ON public.booking_status_history FOR SELECT TO authenticated USING (
  EXISTS (SELECT 1 FROM public.bookings b WHERE b.id = booking_id AND b.client_id = public.eventsync_client_id())
);
DROP POLICY IF EXISTS event_orders_staff_manage ON public.event_orders;
CREATE POLICY event_orders_staff_manage ON public.event_orders FOR ALL TO authenticated
  USING (public.eventsync_is_staff()) WITH CHECK (public.eventsync_is_staff());

-- Table privileges complement RLS: a policy alone does not grant a table privilege.
GRANT USAGE ON SCHEMA public TO authenticated;
GRANT SELECT ON public.user_profiles, public.venues, public.halls, public.resource_types,
  public.venue_resource_capacity, public.clients, public.bookings,
  public.booking_resource_allocations, public.audit_events, public.booking_status_history,
  public.event_orders TO authenticated;
GRANT SELECT ON public.active_bookings, public.resource_utilization,
  public.v_booking_request_outcomes, public.v_hall_utilisation, public.v_venue_utilisation,
  public.v_resource_peak_demand, public.v_demand_heatmap, public.v_rejection_analysis,
  public.v_lifecycle_trends, public.v_data_quality_findings TO authenticated;
GRANT INSERT, UPDATE, DELETE ON public.venues, public.halls, public.resource_types,
  public.venue_resource_capacity, public.clients, public.event_orders TO authenticated;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO authenticated;
-- No policies or grants are defined for idempotency_records: authenticated clients cannot access them directly.

-- PostgreSQL 15+ supports invoker-security views. Prevent views from accidentally bypassing base-table RLS.
ALTER VIEW public.active_bookings SET (security_invoker = true);
ALTER VIEW public.resource_utilization SET (security_invoker = true);
ALTER VIEW public.v_booking_request_outcomes SET (security_invoker = true);
ALTER VIEW public.v_hall_utilisation SET (security_invoker = true);
ALTER VIEW public.v_venue_utilisation SET (security_invoker = true);
ALTER VIEW public.v_resource_peak_demand SET (security_invoker = true);
ALTER VIEW public.v_demand_heatmap SET (security_invoker = true);
ALTER VIEW public.v_rejection_analysis SET (security_invoker = true);
ALTER VIEW public.v_lifecycle_trends SET (security_invoker = true);
ALTER VIEW public.v_data_quality_findings SET (security_invoker = true);

-- Common deterministic advisory-lock ordering, shared with the Node allocator (venue id, UTC day number).
CREATE OR REPLACE FUNCTION public._eventsync_lock_dates(p_dates date[])
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE d date; v record; day_key integer;
BEGIN
  FOR d IN SELECT DISTINCT date_value FROM unnest(p_dates) AS dates(date_value) WHERE date_value IS NOT NULL ORDER BY date_value LOOP
    day_key := d - DATE '1970-01-01';
    FOR v IN SELECT id FROM public.venues ORDER BY id LOOP
      PERFORM pg_advisory_xact_lock(v.id, day_key);
    END LOOP;
  END LOOP;
END;
$$;

-- Returns a proposed allocation without changing data. Used by all booking RPC operations.
CREATE OR REPLACE FUNCTION public._eventsync_find_allocation(p_request jsonb, p_exclude_booking_id integer DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_client_id integer := (p_request ->> 'client_id')::integer;
  v_preferred_venue_id integer := (p_request ->> 'preferred_venue_id')::integer;
  v_event_date date := (p_request ->> 'event_date')::date;
  v_start time := (p_request ->> 'event_start')::time;
  v_end time := (p_request ->> 'event_end')::time;
  v_reserved_start time;
  v_reserved_end time;
  v_attendees integer := (p_request ->> 'attendees')::integer;
  v_projectors integer := COALESCE((p_request ->> 'projectors_requested')::integer, 0);
  v_audio integer := COALESCE((p_request ->> 'audio_systems_requested')::integer, 0);
  v_staff integer := COALESCE((p_request ->> 'staff_requested')::integer, 0);
  cand record;
  req record;
  v_peak integer;
  v_capacity integer;
  v_name text;
  v_valid boolean := true;
  v_reason text := NULL;
BEGIN
  IF v_client_id IS NULL OR v_preferred_venue_id IS NULL OR v_event_date IS NULL
     OR v_start IS NULL OR v_end IS NULL OR v_attendees IS NULL THEN
    RETURN jsonb_build_object('success', false, 'message', 'Required booking fields are missing.');
  END IF;
  IF v_start >= v_end OR v_attendees < 1 OR v_projectors < 0 OR v_audio < 0 OR v_staff < 0 THEN
    RETURN jsonb_build_object('success', false, 'message', 'Invalid event interval, attendance, or resource quantity.');
  END IF;
  v_reserved_start := v_start - INTERVAL '30 minutes';
  v_reserved_end := v_end + INTERVAL '30 minutes';
  IF v_reserved_start < TIME '08:00' OR v_reserved_end > TIME '22:00' THEN
    RETURN jsonb_build_object('success', false, 'message', 'The complete event including 30-minute setup and cleanup buffers must be within 08:00–22:00.');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.clients c WHERE c.id = v_client_id AND c.is_active)
     OR NOT EXISTS (SELECT 1 FROM public.venues v WHERE v.id = v_preferred_venue_id) THEN
    RETURN jsonb_build_object('success', false, 'message', 'Client does not exist or is inactive, or preferred venue does not exist.');
  END IF;

  FOR cand IN
    SELECT v.id AS venue_id, v.name AS venue_name, h.id AS hall_id, h.name AS hall_name, h.capacity AS hall_capacity
    FROM public.venues v
    JOIN public.halls h ON h.venue_id = v.id AND h.is_active AND h.capacity >= v_attendees
    ORDER BY CASE WHEN v.id = v_preferred_venue_id THEN 0 ELSE 1 END, v.id, h.capacity, h.id
  LOOP
    IF EXISTS (
      SELECT 1 FROM public.bookings b
      WHERE b.status = 'confirmed' AND b.hall_id = cand.hall_id
        AND b.event_date = v_event_date AND (p_exclude_booking_id IS NULL OR b.id <> p_exclude_booking_id)
        AND tsrange((b.event_date + b.reserved_start)::timestamp, (b.event_date + b.reserved_end)::timestamp, '[)')
            && tsrange((v_event_date + v_reserved_start)::timestamp, (v_event_date + v_reserved_end)::timestamp, '[)')
    ) THEN
      CONTINUE;
    END IF;

    v_valid := true;
    FOR req IN
      SELECT rt.id AS resource_type_id, rt.name,
        CASE rt.name WHEN 'projector' THEN v_projectors WHEN 'audio_system' THEN v_audio WHEN 'support_staff' THEN v_staff ELSE 0 END AS quantity,
        COALESCE(vrc.capacity, 0) AS capacity
      FROM public.resource_types rt
      LEFT JOIN public.venue_resource_capacity vrc ON vrc.resource_type_id = rt.id AND vrc.venue_id = cand.venue_id
      WHERE rt.name IN ('projector', 'audio_system', 'support_staff')
    LOOP
      IF req.quantity > req.capacity THEN v_valid := false; EXIT; END IF;
      IF req.quantity = 0 THEN CONTINUE; END IF;
      WITH points AS (
        SELECT v_reserved_start AS t
        UNION
        SELECT b.reserved_start
        FROM public.bookings b
        WHERE b.status = 'confirmed' AND b.venue_id = cand.venue_id AND b.event_date = v_event_date
          AND (p_exclude_booking_id IS NULL OR b.id <> p_exclude_booking_id)
          AND b.reserved_start >= v_reserved_start AND b.reserved_start < v_reserved_end
          AND EXISTS (
            SELECT 1 FROM public.booking_resource_allocations x
            WHERE x.booking_id = b.id AND x.resource_type_id = req.resource_type_id AND x.quantity_allocated > 0
          )
      ), usage_at_point AS (
        SELECT p.t, COALESCE(SUM(a.quantity_allocated), 0)::integer AS used
        FROM points p
        LEFT JOIN public.bookings b
          ON b.status = 'confirmed' AND b.venue_id = cand.venue_id AND b.event_date = v_event_date
         AND (p_exclude_booking_id IS NULL OR b.id <> p_exclude_booking_id)
         AND b.reserved_start <= p.t AND b.reserved_end > p.t
        LEFT JOIN public.booking_resource_allocations a ON a.booking_id = b.id AND a.resource_type_id = req.resource_type_id
        GROUP BY p.t
      )
      SELECT COALESCE(MAX(used), 0) INTO v_peak FROM usage_at_point;
      IF v_peak + req.quantity > req.capacity THEN v_valid := false; EXIT; END IF;
    END LOOP;

    IF v_valid THEN
      RETURN jsonb_build_object(
        'success', true, 'venue_id', cand.venue_id, 'venue_name', cand.venue_name,
        'hall_id', cand.hall_id, 'hall_name', cand.hall_name, 'hall_capacity', cand.hall_capacity,
        'reserved_start', v_reserved_start, 'reserved_end', v_reserved_end
      );
    END IF;
  END LOOP;
  RETURN jsonb_build_object('success', false, 'message', 'No feasible hall and shared-resource allocation is available for the requested interval.');
END;
$$;

-- Private helper: FIFO waitlist promotion; called inside cancellation/reschedule transactions.
CREATE OR REPLACE FUNCTION public._eventsync_promote_waitlist(p_event_date date, p_actor uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE w record; alloc jsonb; promoted jsonb := '[]'::jsonb; new_venue integer; new_hall integer; r record;
BEGIN
  FOR w IN SELECT * FROM public.bookings WHERE status = 'waitlisted' AND event_date = p_event_date ORDER BY created_at, id FOR UPDATE LOOP
    alloc := public._eventsync_find_allocation(to_jsonb(w), NULL);
    IF COALESCE((alloc->>'success')::boolean, false) IS NOT TRUE THEN CONTINUE; END IF;
    new_venue := (alloc->>'venue_id')::integer; new_hall := (alloc->>'hall_id')::integer;
    UPDATE public.bookings SET status = 'confirmed', venue_id = new_venue, hall_id = new_hall,
      reserved_start = (alloc->>'reserved_start')::time, reserved_end = (alloc->>'reserved_end')::time,
      rejection_reason = NULL, rejection_code = NULL, updated_at = NOW()
      WHERE id = w.id AND status = 'waitlisted';
    IF NOT FOUND THEN CONTINUE; END IF;
    DELETE FROM public.booking_resource_allocations WHERE booking_id = w.id;
    INSERT INTO public.booking_resource_allocations (booking_id, resource_type_id, quantity_allocated)
    SELECT w.id, rt.id, x.qty FROM (VALUES ('projector', w.projectors_requested), ('audio_system', w.audio_systems_requested), ('support_staff', w.staff_requested)) x(name, qty)
    JOIN public.resource_types rt ON rt.name = x.name WHERE x.qty > 0;
    INSERT INTO public.audit_events (event_type, booking_id, client_id, actor, event_data)
    VALUES ('waitlist_promoted', w.id, w.client_id, p_actor::text,
      jsonb_build_object('venue_id', new_venue, 'hall_id', new_hall, 'reason', 'Promoted automatically after capacity was released'));
    promoted := promoted || jsonb_build_array(jsonb_build_object('id', w.id, 'venue_id', new_venue, 'hall_id', new_hall, 'venue_name', alloc->>'venue_name', 'hall_name', alloc->>'hall_name'));
  END LOOP;
  RETURN promoted;
END;
$$;

CREATE OR REPLACE FUNCTION public.create_booking(p_request jsonb, p_idempotency_key text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE uid uuid := auth.uid(); role_name text; mapped_client integer; req jsonb := p_request; alloc jsonb;
  cid integer; preferred integer; event_day date; event_start time; event_end time; rs time; re time;
  inserted public.bookings%ROWTYPE; response jsonb; scoped_key text; cached public.idempotency_records%ROWTYPE; window_ok boolean;
BEGIN
  SELECT role, client_id INTO role_name, mapped_client FROM public.user_profiles WHERE user_id = uid;
  IF uid IS NULL OR role_name IS NULL THEN RAISE EXCEPTION 'Authenticated EventSync profile required' USING ERRCODE='42501'; END IF;
  IF role_name NOT IN ('admin','manager','staff','client') THEN RAISE EXCEPTION 'Role is not allowed to create bookings' USING ERRCODE='42501'; END IF;
  cid := COALESCE((req->>'client_id')::integer, mapped_client);
  IF role_name = 'client' THEN
    IF mapped_client IS NULL OR cid IS DISTINCT FROM mapped_client THEN RAISE EXCEPTION 'Clients may only create bookings for their linked client account' USING ERRCODE='42501'; END IF;
    req := jsonb_set(req, '{client_id}', to_jsonb(mapped_client), true);
  END IF;

  -- Return a cached response before time-sensitive business validation so retries
  -- remain idempotent even if the event date has since passed or data changed.
  IF p_idempotency_key IS NOT NULL THEN
    IF length(p_idempotency_key) > 258 OR length(p_idempotency_key) = 0 THEN RAISE EXCEPTION 'Invalid idempotency key'; END IF;
    scoped_key := uid::text || ':' || p_idempotency_key;
    PERFORM pg_advisory_xact_lock(hashtext('eventsync-idempotency:' || scoped_key));
    SELECT * INTO cached FROM public.idempotency_records WHERE idempotency_key = scoped_key AND expires_at > NOW();
    IF FOUND THEN
      IF cached.request_hash <> md5(req::text) THEN RAISE EXCEPTION 'Idempotency key was reused with a different request' USING ERRCODE='23505'; END IF;
      RETURN cached.response_data;
    END IF;
  END IF;

  preferred := (req->>'preferred_venue_id')::integer;
  event_day := (req->>'event_date')::date;
  event_start := (req->>'event_start')::time;
  event_end := (req->>'event_end')::time;

  -- Validate the payload inside the database as well as at the HTTP boundary.
  -- These RPCs are exposed to authenticated Supabase callers, so malformed requests
  -- must not fall through to a table constraint error or create invalid rejected rows.
  IF event_day IS NULL OR event_day < CURRENT_DATE THEN
    RETURN jsonb_build_object('success', false, 'booking', NULL, 'message', 'Event date must be today or in the future.');
  END IF;
  IF event_start IS NULL OR event_end IS NULL OR event_start >= event_end THEN
    RETURN jsonb_build_object('success', false, 'booking', NULL, 'message', 'Event start must be before event end.');
  END IF;
  IF event_start < TIME '00:30' OR event_end > TIME '23:29' THEN
    RETURN jsonb_build_object('success', false, 'booking', NULL, 'message', 'Event times must leave room for the 30-minute buffers within one calendar day.');
  END IF;
  IF length(btrim(COALESCE(req->>'event_name', ''))) < 1 OR length(req->>'event_name') > 255 THEN
    RETURN jsonb_build_object('success', false, 'booking', NULL, 'message', 'Event name is required and must be at most 255 characters.');
  END IF;
  IF COALESCE((req->>'attendees')::integer, 0) < 1 THEN
    RETURN jsonb_build_object('success', false, 'booking', NULL, 'message', 'Attendees must be a positive integer.');
  END IF;
  IF COALESCE((req->>'projectors_requested')::integer, 0) < 0
     OR COALESCE((req->>'audio_systems_requested')::integer, 0) < 0
     OR COALESCE((req->>'staff_requested')::integer, 0) < 0 THEN
    RETURN jsonb_build_object('success', false, 'booking', NULL, 'message', 'Resource quantities cannot be negative.');
  END IF;

  IF cid IS NULL OR NOT EXISTS (SELECT 1 FROM public.clients c WHERE c.id = cid AND c.is_active) THEN
    RETURN jsonb_build_object('success', false, 'booking', NULL, 'message', 'Client does not exist or is inactive.');
  END IF;
  IF preferred IS NULL OR NOT EXISTS (SELECT 1 FROM public.venues v WHERE v.id = preferred) THEN
    RETURN jsonb_build_object('success', false, 'booking', NULL, 'message', 'Preferred venue does not exist.');
  END IF;
  PERFORM public._eventsync_lock_dates(ARRAY[event_day]);
  window_ok := event_start >= TIME '08:30' AND event_end <= TIME '21:30' AND event_start < event_end;
  alloc := public._eventsync_find_allocation(req, NULL);
  rs := (alloc->>'reserved_start')::time; re := (alloc->>'reserved_end')::time;
  IF rs IS NULL OR re IS NULL THEN
    -- TIME cannot represent a reservation that wraps across midnight. Return a controlled
    -- failure for these malformed intervals instead of violating the stored interval constraints.
    IF event_start < TIME '00:30' OR event_end >= TIME '23:30' THEN
      RETURN jsonb_build_object('success', false, 'booking', NULL, 'message',
        'The event plus its 30-minute buffers cannot be represented within a single calendar day.');
    END IF;
    rs := event_start - INTERVAL '30 minutes'; re := event_end + INTERVAL '30 minutes';
  END IF;
  INSERT INTO public.bookings (client_id, hall_id, venue_id, preferred_venue_id,
    projectors_requested, audio_systems_requested, staff_requested, event_name, event_date,
    event_start, event_end, reserved_start, reserved_end, attendees, status,
    rejection_reason, rejection_code, created_by, correlation_id)
  VALUES (cid, CASE WHEN COALESCE((alloc->>'success')::boolean,false) THEN (alloc->>'hall_id')::integer ELSE NULL END,
    CASE WHEN COALESCE((alloc->>'success')::boolean,false) THEN (alloc->>'venue_id')::integer ELSE preferred END,
    preferred, COALESCE((req->>'projectors_requested')::integer,0), COALESCE((req->>'audio_systems_requested')::integer,0),
    COALESCE((req->>'staff_requested')::integer,0), req->>'event_name', event_day, event_start, event_end, rs, re,
    (req->>'attendees')::integer,
    CASE WHEN NOT window_ok THEN 'rejected'::public.booking_status
         WHEN COALESCE((alloc->>'success')::boolean,false) THEN 'confirmed'::public.booking_status
         WHEN COALESCE((req->>'waitlist_if_full')::boolean,false) THEN 'waitlisted'::public.booking_status ELSE 'rejected'::public.booking_status END,
    CASE WHEN COALESCE((alloc->>'success')::boolean,false) THEN NULL ELSE COALESCE(alloc->>'message','No feasible allocation was found') END,
    CASE WHEN COALESCE((alloc->>'success')::boolean,false) THEN NULL WHEN NOT window_ok THEN 'OUTSIDE_OPERATING_HOURS' ELSE 'NO_AVAILABILITY' END,
    uid::text, NULL)
  RETURNING * INTO inserted;
  IF inserted.status = 'confirmed' THEN
    INSERT INTO public.booking_resource_allocations (booking_id, resource_type_id, quantity_allocated)
    SELECT inserted.id, rt.id, x.qty FROM (VALUES ('projector', inserted.projectors_requested), ('audio_system', inserted.audio_systems_requested), ('support_staff', inserted.staff_requested)) x(name, qty)
    JOIN public.resource_types rt ON rt.name = x.name WHERE x.qty > 0;
    INSERT INTO public.audit_events(event_type, booking_id, client_id, actor, event_data)
    VALUES ('booking_confirmed', inserted.id, inserted.client_id, uid::text,
      jsonb_build_object('venue_id', alloc->>'venue_id','hall_id',alloc->>'hall_id','source','supabase_rpc'));
  ELSIF inserted.status = 'waitlisted' THEN
    INSERT INTO public.audit_events(event_type, booking_id, client_id, actor, event_data)
    VALUES ('booking_waitlisted', inserted.id, inserted.client_id, uid::text, jsonb_build_object('reason', inserted.rejection_reason));
  ELSE
    INSERT INTO public.audit_events(event_type, booking_id, client_id, actor, event_data)
    VALUES ('booking_rejected', inserted.id, inserted.client_id, uid::text, jsonb_build_object('reason', inserted.rejection_reason));
  END IF;
  response := jsonb_build_object('success', inserted.status='confirmed', 'waitlisted', inserted.status='waitlisted',
    'booking', to_jsonb(inserted), 'allocation', alloc, 'message', CASE WHEN inserted.status='confirmed' THEN
      'Event confirmed at ' || (alloc->>'venue_name') || ' - ' || (alloc->>'hall_name') ELSE inserted.rejection_reason END);
  IF p_idempotency_key IS NOT NULL THEN
    INSERT INTO public.idempotency_records(idempotency_key, request_hash, booking_id, response_data, expires_at)
    VALUES (scoped_key, md5(req::text), inserted.id, response, NOW() + INTERVAL '24 hours')
    ON CONFLICT (idempotency_key) DO UPDATE SET request_hash=EXCLUDED.request_hash, response_data=EXCLUDED.response_data, booking_id=EXCLUDED.booking_id, expires_at=EXCLUDED.expires_at;
  END IF;
  RETURN response;
END;
$$;

CREATE OR REPLACE FUNCTION public.cancel_booking(p_booking_id integer, p_reason text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE uid uuid := auth.uid(); role_name text; mapped_client integer; b public.bookings%ROWTYPE; released jsonb; promoted jsonb; locked_date date;
BEGIN
  SELECT role, client_id INTO role_name, mapped_client FROM public.user_profiles WHERE user_id=uid;
  IF uid IS NULL OR role_name IS NULL OR role_name NOT IN ('admin','manager','staff','client') THEN RAISE EXCEPTION 'Authentication required' USING ERRCODE='42501'; END IF;
  -- Lock allocation dates before locking the booking row, matching the global lock order.
  SELECT * INTO b FROM public.bookings WHERE id=p_booking_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Booking not found'; END IF;
  locked_date := b.event_date;
  PERFORM public._eventsync_lock_dates(ARRAY[locked_date]);
  SELECT * INTO b FROM public.bookings WHERE id=p_booking_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Booking not found'; END IF;
  IF b.event_date IS DISTINCT FROM locked_date THEN RAISE EXCEPTION 'Booking changed concurrently; retry the cancellation' USING ERRCODE='40001'; END IF;
  IF b.status <> 'confirmed' THEN RAISE EXCEPTION 'Booking is not in confirmed status'; END IF;
  IF role_name='client' AND b.client_id IS DISTINCT FROM mapped_client THEN RAISE EXCEPTION 'Booking not found' USING ERRCODE='P0002'; END IF;
  SELECT COALESCE(jsonb_agg(jsonb_build_object('resource_type',rt.name,'quantity',a.quantity_allocated)), '[]'::jsonb)
    INTO released FROM public.booking_resource_allocations a JOIN public.resource_types rt ON rt.id=a.resource_type_id WHERE a.booking_id=b.id;
  UPDATE public.bookings SET status='cancelled', rejection_reason=left(p_reason,500), updated_at=NOW()
    WHERE id=b.id AND status='confirmed' RETURNING * INTO b;
  IF NOT FOUND THEN RAISE EXCEPTION 'Booking is not in confirmed status'; END IF;
  DELETE FROM public.booking_resource_allocations WHERE booking_id=b.id;
  INSERT INTO public.audit_events(event_type,booking_id,client_id,actor,event_data)
    VALUES('booking_cancelled',b.id,b.client_id,uid::text,jsonb_build_object('reason',p_reason,'released_allocations',released));
  promoted := public._eventsync_promote_waitlist(b.event_date,uid);
  RETURN jsonb_build_object('success',true,'booking',to_jsonb(b),'promoted',promoted,'message','Booking cancelled and allocations released.');
END;
$$;

CREATE OR REPLACE FUNCTION public.reschedule_booking(p_booking_id integer, p_request jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE uid uuid := auth.uid(); role_name text; mapped_client integer; b public.bookings%ROWTYPE; req jsonb := p_request;
  new_date date; old_date date; alloc jsonb; rs time; re time; changed public.bookings%ROWTYPE; promoted jsonb;
BEGIN
  SELECT role, client_id INTO role_name, mapped_client FROM public.user_profiles WHERE user_id=uid;
  IF uid IS NULL OR role_name IS NULL OR role_name NOT IN ('admin','manager','staff','client') THEN RAISE EXCEPTION 'Authentication required' USING ERRCODE='42501'; END IF;
  -- Read without a row lock, acquire date locks in deterministic order, then lock the booking.
  SELECT * INTO b FROM public.bookings WHERE id=p_booking_id AND status='confirmed';
  IF NOT FOUND THEN RAISE EXCEPTION 'Booking not found or not in confirmed status'; END IF;
  old_date := b.event_date;
  new_date := (req->>'event_date')::date;
  PERFORM public._eventsync_lock_dates(ARRAY[old_date,new_date]);
  SELECT * INTO b FROM public.bookings WHERE id=p_booking_id AND status='confirmed' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Booking not found or not in confirmed status'; END IF;
  IF b.event_date IS DISTINCT FROM old_date THEN RAISE EXCEPTION 'Booking changed concurrently; retry the reschedule' USING ERRCODE='40001'; END IF;
  IF role_name='client' AND b.client_id IS DISTINCT FROM mapped_client THEN RAISE EXCEPTION 'Booking not found or not in confirmed status' USING ERRCODE='P0002'; END IF;
  IF COALESCE((req->>'client_id')::integer,b.client_id) <> b.client_id THEN RAISE EXCEPTION 'A booking cannot be reassigned to a different client' USING ERRCODE='22023'; END IF;
  req := jsonb_set(req,'{client_id}',to_jsonb(b.client_id),true);
  alloc := public._eventsync_find_allocation(req,p_booking_id);
  IF COALESCE((alloc->>'success')::boolean,false) IS NOT TRUE THEN
    INSERT INTO public.audit_events(event_type,booking_id,client_id,actor,event_data)
    VALUES('booking_reschedule_failed',b.id,b.client_id,uid::text,jsonb_build_object('reason',alloc->>'message'));
    RETURN jsonb_build_object('success',false,'booking',to_jsonb(b),'message','Cannot reschedule: ' || COALESCE(alloc->>'message','no feasible allocation'));
  END IF;
  rs := (alloc->>'reserved_start')::time; re := (alloc->>'reserved_end')::time;
  UPDATE public.bookings SET venue_id=(alloc->>'venue_id')::integer,hall_id=(alloc->>'hall_id')::integer,
    preferred_venue_id=(req->>'preferred_venue_id')::integer,event_name=req->>'event_name',event_date=new_date,
    event_start=(req->>'event_start')::time,event_end=(req->>'event_end')::time,reserved_start=rs,reserved_end=re,
    attendees=(req->>'attendees')::integer,projectors_requested=COALESCE((req->>'projectors_requested')::integer,0),
    audio_systems_requested=COALESCE((req->>'audio_systems_requested')::integer,0),staff_requested=COALESCE((req->>'staff_requested')::integer,0),
    rejection_reason=NULL,rejection_code=NULL,updated_at=NOW()
    WHERE id=p_booking_id RETURNING * INTO changed;
  DELETE FROM public.booking_resource_allocations WHERE booking_id=changed.id;
  INSERT INTO public.booking_resource_allocations(booking_id,resource_type_id,quantity_allocated)
    SELECT changed.id,rt.id,x.qty FROM (VALUES('projector',changed.projectors_requested),('audio_system',changed.audio_systems_requested),('support_staff',changed.staff_requested)) x(name,qty)
    JOIN public.resource_types rt ON rt.name=x.name WHERE x.qty>0;
  INSERT INTO public.audit_events(event_type,booking_id,client_id,actor,event_data)
    VALUES('booking_reschedule_succeeded',changed.id,changed.client_id,uid::text,jsonb_build_object('venue_id',changed.venue_id,'hall_id',changed.hall_id,'event_date',changed.event_date));
  promoted := public._eventsync_promote_waitlist(b.event_date,uid);
  RETURN jsonb_build_object('success',true,'booking',to_jsonb(changed),'allocation',alloc,'promoted',promoted,'message','Booking rescheduled successfully.');
END;
$$;

CREATE OR REPLACE FUNCTION public.promote_waitlist(p_event_date date)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE uid uuid := auth.uid(); role_name text;
BEGIN
  SELECT role INTO role_name FROM public.user_profiles WHERE user_id=uid;
  IF uid IS NULL OR role_name IS NULL OR role_name NOT IN ('admin','manager','staff') THEN RAISE EXCEPTION 'Staff or manager role required' USING ERRCODE='42501'; END IF;
  PERFORM public._eventsync_lock_dates(ARRAY[p_event_date]);
  RETURN public._eventsync_promote_waitlist(p_event_date,uid);
END;
$$;

CREATE OR REPLACE FUNCTION public.create_recurring_series(
  p_request jsonb, p_occurrences integer, p_every_days integer DEFAULT 7,
  p_all_or_nothing boolean DEFAULT true, p_idempotency_key text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE uid uuid := auth.uid(); role_name text; mapped_client integer; req jsonb:=p_request; base_date date; dates date[]; i integer;
  item jsonb; created jsonb; results jsonb:='[]'::jsonb; failures jsonb:='[]'::jsonb; key text;
BEGIN
  SELECT role,client_id INTO role_name,mapped_client FROM public.user_profiles WHERE user_id=uid;
  IF uid IS NULL OR role_name IS NULL OR role_name NOT IN ('admin','manager','staff','client') THEN RAISE EXCEPTION 'Authentication required' USING ERRCODE='42501'; END IF;
  IF p_occurrences < 2 OR p_occurrences > 52 OR p_every_days < 1 OR p_every_days > 365 THEN
    RAISE EXCEPTION 'occurrences must be 2-52 and every_days must be 1-365' USING ERRCODE='22023';
  END IF;
  IF p_idempotency_key IS NOT NULL AND (length(p_idempotency_key) = 0 OR length(p_idempotency_key) > 255) THEN
    RAISE EXCEPTION 'Invalid idempotency key' USING ERRCODE='22023';
  END IF;
  IF role_name='client' THEN
    IF mapped_client IS NULL OR COALESCE((req->>'client_id')::integer,mapped_client)<>mapped_client THEN RAISE EXCEPTION 'Client profile is not linked to this client account' USING ERRCODE='42501'; END IF;
    req:=jsonb_set(req,'{client_id}',to_jsonb(mapped_client),true);
  END IF;
  base_date:=(req->>'event_date')::date;
  SELECT array_agg(base_date + (n*p_every_days) ORDER BY n) INTO dates FROM generate_series(0,p_occurrences-1) n;
  PERFORM public._eventsync_lock_dates(dates);
  -- Exception block creates a savepoint. Raising on a failed occurrence rolls back every occurrence in all-or-nothing mode.
  BEGIN
    FOR i IN 0..p_occurrences-1 LOOP
      item:=jsonb_set(req,'{event_date}',to_jsonb((base_date+(i*p_every_days))::text),true);
      created:=public.create_booking(item, CASE WHEN p_idempotency_key IS NULL THEN NULL ELSE p_idempotency_key || ':' || (i+1)::text END);
      IF COALESCE((created->>'success')::boolean,false) IS NOT TRUE THEN
        failures:=failures||jsonb_build_array(jsonb_build_object('occurrence',i+1,'event_date',base_date+(i*p_every_days),'reason',created->>'message'));
        IF p_all_or_nothing THEN RAISE EXCEPTION 'Occurrence % failed: %',i+1,created->>'message' USING ERRCODE='P0001'; END IF;
      ELSE
        results:=results||jsonb_build_array(jsonb_build_object('occurrence',i+1,'event_date',base_date+(i*p_every_days),'result',created));
      END IF;
    END LOOP;
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    RETURN jsonb_build_object('success',false,'created',0,'failures',failures,'message',SQLERRM);
  END;
  RETURN jsonb_build_object('success',jsonb_array_length(failures)=0,'created',jsonb_array_length(results),'occurrences',results,'failures',failures,
    'message',format('%s of %s recurring bookings created.',jsonb_array_length(results),p_occurrences));
END;
$$;

-- Private helpers are callable by the definer functions but not directly by browser roles.
REVOKE ALL ON FUNCTION public._eventsync_lock_dates(date[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._eventsync_find_allocation(jsonb, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._eventsync_promote_waitlist(date, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_booking(jsonb, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.cancel_booking(integer, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.reschedule_booking(integer, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.promote_waitlist(date) TO authenticated;
GRANT EXECUTE ON FUNCTION public.create_recurring_series(jsonb, integer, integer, boolean, text) TO authenticated;
REVOKE ALL ON FUNCTION public.create_booking(jsonb, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.cancel_booking(integer, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.reschedule_booking(integer, jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.promote_waitlist(date) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.create_recurring_series(jsonb, integer, integer, boolean, text) FROM PUBLIC, anon;

-- END MIGRATION: 20261030000004_auth_rls_rpc.sql


-- ============================================================================
-- BEGIN SEED DATA (reference venues, halls, resource capacity, demo clients)
-- ============================================================================

-- Seed the official EventSync hackathon dataset on a fresh Supabase project.
INSERT INTO public.venues (name) VALUES ('Venue A'), ('Venue B'), ('Venue C')
ON CONFLICT (name) DO NOTHING;

INSERT INTO public.resource_types (name, description, unit) VALUES
  ('projector', 'Digital projectors for presentations', 'units'),
  ('audio_system', 'Audio systems for events', 'units'),
  ('support_staff', 'Support staff members', 'people')
ON CONFLICT (name) DO NOTHING;

INSERT INTO public.halls (venue_id, name, capacity)
SELECT v.id, x.hall_name, x.capacity
FROM (VALUES ('Venue A','A1',60),('Venue A','A2',150),('Venue B','B1',100),('Venue B','B2',200),('Venue C','C1',80),('Venue C','C2',250)) AS x(venue_name,hall_name,capacity)
JOIN public.venues v ON v.name=x.venue_name
ON CONFLICT (venue_id,name) DO UPDATE SET capacity=EXCLUDED.capacity, is_active=true;

INSERT INTO public.venue_resource_capacity (venue_id, resource_type_id, capacity)
SELECT v.id, rt.id, x.capacity
FROM (VALUES
  ('Venue A','projector',2),('Venue A','audio_system',2),('Venue A','support_staff',5),
  ('Venue B','projector',2),('Venue B','audio_system',1),('Venue B','support_staff',4),
  ('Venue C','projector',3),('Venue C','audio_system',2),('Venue C','support_staff',6)
) AS x(venue_name,resource_name,capacity)
JOIN public.venues v ON v.name=x.venue_name
JOIN public.resource_types rt ON rt.name=x.resource_name
ON CONFLICT (venue_id,resource_type_id) DO UPDATE SET capacity=EXCLUDED.capacity;

-- Demo client records. Safe to rerun; existing clients/bookings are preserved.
INSERT INTO public.clients (name, email, phone, organization)
SELECT x.name, x.email, x.phone, x.organization
FROM (VALUES
  ('TechCorp Solutions', 'contact@techcorp.com', '+1-555-0101', 'Technology Company'),
  ('Marketing Masters', 'events@marketingmasters.com', '+1-555-0102', 'Marketing Agency'),
  ('Innovation Labs', 'hello@innovationlabs.io', '+1-555-0103', 'Research Institute'),
  ('Global Ventures', 'info@globalventures.com', '+1-555-0104', 'Investment Firm'),
  ('Creative Studio', 'bookings@creativestudio.net', '+1-555-0105', 'Design Agency')
) AS x(name, email, phone, organization)
WHERE NOT EXISTS (
  SELECT 1 FROM public.clients c WHERE lower(c.email) = lower(x.email)
);

-- Database schema and reference seed data have been installed.

COMMIT;
