# Analytics and data quality

## Dashboard metrics

- **Total bookings:** all booking request records, including cancelled, rejected, and waitlisted records.
- **Confirmed:** bookings currently holding a hall allocation.
- **Cancelled / rejected / waitlisted:** counts by current status, not distinct clients.
- **Upcoming events:** confirmed events with an event date on or after the database's current date.
- **Venue hall utilisation (next 30 days):** the sum of confirmed reservation hours at a venue divided by `active hall count × 14 operating hours/day × 30 days`. Numerator and denominator both use hall-hours; reservation durations include setup/cleanup buffers. The displayed definition accompanies the metric.
- **Resource utilisation:** the `resource_utilization` view returns resource usage for each segment created by confirmed allocation start/end boundaries, allowing the sum for simultaneous reservations to be compared with the venue capacity.

The dashboard metric is not “booking count divided by all bookings.” It uses reserved hall-hours and available hall-hours so that a one-hour booking and a six-hour booking contribute differently.

## Data quality guardrails

The schema and services protect common errors with foreign keys, enums, non-negative resource checks, positive attendee counts, required rejection reasons, status history, and unique idempotency keys. More complex integrity checks should be run periodically or added to the data-quality screen as needed:

- Confirmed bookings without hall or allocation information.
- Confirmed hall interval overlaps.
- Resource-utilisation segments with negative available quantity.
- Invalid or missing preferred venue and client references.
- Duplicate or malformed import rows if bulk import is added later.
- Unusual ratios of rejected, cancelled, or waitlisted requests.

## Data lineage

Current state lives in `bookings` and `booking_resource_allocations`. `booking_status_history` is database-triggered. `audit_events` describes meaningful decisions/actions with correlation IDs and JSON metadata. Analytics are derived from those tables/views and are not hardcoded in the frontend.
