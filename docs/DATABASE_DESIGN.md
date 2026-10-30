# Database design

The schema is normalised around venues, halls, clients, resource types, bookings, and actual resource allocations. The initial schema lives at `backend/src/database/migrations/001_initial_schema.sql` and is executed transactionally by the migration runner.

## Main tables

| Table | Responsibility |
|---|---|
| `venues` | Venue identity and timestamps |
| `halls` | Venue-owned halls and attendee capacities |
| `clients` | Client/contact information |
| `resource_types` | Shared resource catalog: `projector`, `audio_system`, `support_staff` |
| `venue_resource_capacity` | Capacity of each resource type at each venue |
| `bookings` | Event details, requested resources, reservation interval, status, preferred/actual venue and series fields |
| `booking_resource_allocations` | Resource quantities allocated to a confirmed booking |
| `idempotency_records` | Request hash and cached response for safe retries |
| `audit_events` | Decision/action events and structured metadata |
| `booking_status_history` | Status changes captured by a database trigger |
| `schema_migrations` | Applied migration ledger, created by the migration runner |

## Important invariants

- Foreign keys keep clients, venues, halls, and resource types referentially consistent.
- Positive attendee counts and non-negative resource requests are enforced by checks.
- `booking_status` is an enum (`confirmed`, `cancelled`, `rejected`, `waitlisted`).
- A confirmed booking must have a hall and no rejection reason. Rejected/waitlisted requests must have no hall and must contain a reason.
- `no_overlapping_hall_bookings` is a GiST exclusion constraint for confirmed reservations with overlapping reserved intervals for the same hall and date.
- `UNIQUE(booking_id, resource_type_id)` prevents duplicate allocation rows for a resource type on one booking.
- Idempotency keys are unique; transaction-scoped advisory locking ensures the request hash is checked and its response stored atomically.
- Status history is trigger-maintained; application audit events are written in the same transaction as the corresponding decision/change.

## Why store both requested demand and actual allocations?

`bookings.projectors_requested`, `audio_systems_requested`, and `staff_requested` preserve the client's demand even when the request is rejected or waitlisted. `booking_resource_allocations` records what was actually allocated to a confirmed booking. Keeping the two concepts distinct supports useful rejection analysis, data-quality checks, and future changes in allocation policy.

## Query/index strategy

Indexes support common filters and joins: booking status/date, venue/date/status, hall/date conflict checks, client history, series occurrence lookup, waitlist FIFO lookup, audit history, and booking/resource allocations. The indexes are intentionally concentrated on actual query paths rather than every column.

The `resource_utilization` view segments the day at confirmed allocation interval boundaries, then sums resource usage for each segment. It therefore reports overlapping load instead of treating each individual booking as the venue's total usage.

## Seeding

`npm run seed` upserts the three required venues, six halls, resource types, and capacity values, then inserts sample clients only if their email is not already present. It does not truncate bookings or reset identity values.
