# Data dictionary

This dictionary describes the core PostgreSQL tables created by `backend/src/database/migrations/001_initial_schema.sql`. Names are kept close to the SQL schema so the evaluator can map the application to actual records.

## Core/reference tables

| Table | Purpose | Important fields and invariants |
|---|---|---|
| `venues` | Physical event venues | `id` primary key; unique `name`. |
| `halls` | Bookable halls within venues | `venue_id` foreign key; `capacity > 0`; unique hall name per venue; inactive halls are excluded from allocation. |
| `resource_types` | Canonical shared resource types | Unique `name`; seeded as `projector`, `audio_system`, and `support_staff`. |
| `venue_resource_capacity` | Total concurrent resource capacity per venue and type | `capacity >= 0`; one row per `(venue_id, resource_type_id)`. |
| `clients` | Organizations/clients requesting events | Active flag; optional contact details. |

## Transactional booking tables

| Table | Purpose | Important fields and invariants |
|---|---|---|
| `bookings` | Current booking/request state | Event date/times, reserved start/end including 30-minute buffers, attendees, preferred venue, allocated venue/hall, requested resource quantities, status, rejection reason/code, correlation ID, and optional recurring-series fields. Confirmed rows require a hall and no rejection reason; rejected/waitlisted rows require a reason. |
| `booking_resource_allocations` | Actual shared resource quantities reserved by confirmed bookings | Foreign keys to booking and resource type; unique `(booking_id, resource_type_id)`; non-negative quantities. Rows are removed when a booking is cancelled and are replaced atomically when rescheduled. |
| `idempotency_records` | Cached result for an API request key | Unique idempotency key, SHA-256 request hash, JSON response, expiry, and optional booking reference. Reusing a key for another payload is rejected. |
| `booking_status_history` | State transitions | Old/new status, reason, timestamp, booking reference. Populated by a database trigger when status changes and when a booking is first inserted. |
| `audit_events` | Operational decision and mutation trail | Event ID/type, booking/client references, correlation ID, event timestamp, and JSON metadata including decision/release details. |

## Derived views

| View | Meaning |
|---|---|
| `active_bookings` | Confirmed bookings enriched with venue, hall, client, and organization names. |
| `resource_utilization` | Occupancy segments per venue/date/resource type, with allocated quantity, remaining capacity, and utilization percentage. Only confirmed bookings contribute. The interval convention is half-open `[start, end)`. |

## Status and interval semantics

- `confirmed`: the hall and requested shared resources are allocated.
- `rejected`: no allocation was made; `rejection_reason` explains the result.
- `waitlisted`: request remains eligible for re-evaluation when capacity is released; no hall/resources are allocated until promoted.
- `cancelled`: no longer consumes active capacity. Its released resource quantities are retained in the cancellation audit event.
- The user-visible event interval is `event_start` to `event_end`; the reserved interval is `reserved_start` to `reserved_end` and includes 30 minutes on either side.
- Event times are stored as local wall-clock `TIME` values according to the assignment's 08:00–22:00 venue operating schedule. The application rejects requests whose buffer interval cannot be represented within the same date.

## Source of truth

Transactional booking rows and resource-allocation rows are authoritative for current state. `audit_events` and `booking_status_history` preserve decision/change history. Reporting queries and views must not treat rejected or cancelled bookings as active reservations.
