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
