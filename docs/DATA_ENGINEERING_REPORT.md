# Data engineering report

Covers the analytics and data-quality layer added in migration
`002_analytics_and_data_quality.sql`. Everything described here was applied and
queried against a real PostgreSQL 16.15 instance; measured output is marked as
such, and anything not measured says so.

## 1. Principles

**Aggregate in the database.** No endpoint loads the booking table into Node to
count it. Each metric is a view; the service layer applies filters, bounds the
result set and formats. The practical consequence is that a dashboard request
transfers tens of rows rather than the entire booking history.

**State the denominator.** Most reporting mistakes are denominator mistakes, so
every view carries its definition in a comment and every API response repeats it
in a `definition` field that the UI displays. A number without its denominator
is not a metric.

**Separate attempts from outcomes.** A request and a confirmed booking are
different events. Rates here divide by *requests recorded*, which includes
rejected and waitlisted ones. Dividing by confirmed bookings would make the
confirmation rate 100% by construction.

**Never count a minute twice.** Utilisation merges overlapping intervals before
summing. Confirmed bookings should not overlap — the exclusion constraint
forbids it — but a metric that silently depends on an invariant holding is a
metric that lies the moment the invariant breaks.

## 2. Metric definitions

| Metric | Numerator | Denominator | View |
|---|---|---|---|
| Confirmation rate | Requests with status `confirmed` | All requests recorded for the date | `v_booking_request_outcomes` |
| Rejection rate | Requests with status `rejected` | All requests recorded for the date | `v_booking_request_outcomes` |
| Hall utilisation | Merged reserved minutes in that hall that day | 840 minutes (08:00–22:00) | `v_hall_utilisation` |
| Venue utilisation | Merged reserved minutes across the venue's halls | active halls × 840 | `v_venue_utilisation` |
| Unused capacity | 840 − merged reserved minutes | — (absolute minutes) | `v_hall_utilisation` |
| Peak resource demand | Max simultaneous allocated quantity | Venue capacity for that resource | `v_resource_peak_demand` |
| Demand by weekday/hour | Requests in the bucket | — (counts, confirmed and rejected split out) | `v_demand_heatmap` |
| Rejection reasons | Refusals per rule class | — (counts) | `v_rejection_analysis` |
| Cancellation rate | Cancelled requests | Requests made that day | `v_lifecycle_trends` |
| Booking lead time | `event_date − created_at::date` | Confirmed bookings only | `v_lifecycle_trends` |

Reserved minutes always include both 30-minute buffers, because the hall is
genuinely unavailable during setup and clearing. Measuring only the event time
would understate utilisation by an hour per booking — on a four-hour event that
is a 20% error.

## 3. Two SQL techniques worth explaining

### Merging overlapping intervals (islands and gaps)

Summing `reserved_end - reserved_start` per hall-day double-counts any overlap.
`v_hall_utilisation` merges first:

```sql
CASE WHEN starts_at > MAX(ends_at) OVER (
       PARTITION BY hall_id, event_date
       ORDER BY starts_at
       ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING)
     THEN 1 ELSE 0 END AS is_new_island
```

A row begins a new island when it starts after the running maximum end time of
everything before it. A running sum of that flag numbers the islands; grouping
by island gives merged intervals whose durations can be added safely.

### Peak concurrency as a SQL sweep line

`v_resource_peak_demand` answers "what is the most of this resource in use at
once" without a procedural loop:

```sql
SELECT ..., +quantity_allocated AS delta, 1 AS ordering  -- at reserved_start
UNION ALL
SELECT ..., -quantity_allocated,          0 AS ordering  -- at reserved_end
...
SUM(delta) OVER (PARTITION BY venue_id, event_date, resource_type_id
                 ORDER BY at_time, ordering ROWS UNBOUNDED PRECEDING)
```

`ordering` is the subtle part. At an identical timestamp, ends must be processed
before starts, or a booking finishing at 13:30 and another starting at 13:30
would momentarily appear to hold the resource simultaneously and report a
phantom spike. This matches the half-open `[start, end)` semantics the booking
engine uses, so the dashboard and the allocator agree about what "full" means.

## 4. Measured results

Against a seeded database holding the problem statement's sample situation
(conference 10:00–13:00 and workshop 11:00–14:00 at Venue A, product launch
13:15–15:15), queried through the API:

```
Hall utilisation
  Venue A A1: 240 min -> 28.57% of 840
  Venue A A2: 240 min -> 28.57% of 840
  Venue B B1: 180 min -> 21.43% of 840

Peak shared-resource demand
  Venue A projector:     peak 2/2 = 100.00%
  Venue A support_staff: peak 5/5 = 100.00%
  Venue B audio_system:  peak 1/1 = 100.00%
  Venue B projector:     peak 1/2 =  50.00%
  Venue B support_staff: peak 2/4 =  50.00%

Data quality: 0 findings
```

Venue A reaching exactly 2/2 projectors and 5/5 staff is the analytical
confirmation of the brief's sample situation: both the conference and the
workshop fit, and the venue is then fully committed, which is why the product
launch overflowed to Venue B.

## 5. Indexes

Added in migration 002, each tied to a query that exists:

| Index | Serves |
|---|---|
| `idx_bookings_status_date (status, event_date)` | every view that filters confirmed bookings over a date range |
| `idx_bookings_rejected_date` (partial, `WHERE status='rejected'`) | `v_rejection_analysis`; partial because refusals are a small minority of rows |
| `idx_bookings_created_at` | `v_lifecycle_trends`, which groups by request date |
| `idx_bra_booking (booking_id, resource_type_id)` | the allocation joins in the resource views and CSV export |

All are `CREATE INDEX IF NOT EXISTS`, so the migration is safe to re-apply.

### Query plans

`EXPLAIN` was run against the seeded development database. At this row count
(single-digit bookings) the planner correctly chooses sequential scans — an
index lookup is not worth the page fetch on a table of three rows — so the plans
confirm the queries are *valid and cheap*, not that the indexes are being used.
The indexes above are justified by query shape rather than by a measured plan
change, and that distinction is deliberate: claiming a measured improvement on
three rows would be dishonest. Re-run `EXPLAIN ANALYZE` after loading a
realistic history before making any performance claim.

## 6. Data-quality monitoring

`v_data_quality_findings` is a read-only union of ten checks. It never updates
or deletes anything; repair is always a human decision. Every row has the same
shape — `check_name, severity, entity, entity_id, detail, recommended_action` —
so the API, the UI table and the CSV export treat findings as one list.

| Check | Severity | Catches |
|---|---|---|
| `confirmed_without_hall` | critical | a confirmed booking holding no hall |
| `allocation_on_inactive_booking` | critical | cancelled or rejected requests still consuming capacity |
| `orphaned_allocation` | critical | allocation rows whose booking is gone |
| `resource_capacity_exceeded` | critical | peak concurrent demand above venue capacity |
| `invalid_interval` | critical | an event that does not end after it starts |
| `outside_operating_hours` | critical | a confirmed hold outside 08:00–22:00 |
| `invalid_resource_quantity` | critical | zero or negative allocated quantities |
| `buffer_mismatch` | warning | reserved interval that is not the event ± 30 minutes |
| `missing_status_history` | warning | a booking with no audit trail |
| `rejection_without_reason` | warning | a refusal that cannot be explained to the client |

Prevention still comes first: `CHECK` constraints and the `EXCLUDE USING gist`
constraint stop most of these at write time. The view covers what constraints
cannot express cheaply — chiefly cross-row invariants such as peak concurrent
resource demand — and acts as a regression detector for the ones that are
supposed to be impossible.

Current status on the seeded database: **0 findings**.

## 7. CSV export

`GET /api/v1/analytics/export/:dataset` where dataset is one of `bookings`,
`allocations`, `audit`, `hall-utilisation`, `resource-demand`, `data-quality`.
Datasets are whitelisted in a `switch`; an unknown value returns 400 rather than
reaching SQL, and the filename is built from the whitelisted name, never from
user input.

Two safety properties:

**Formula injection.** A cell beginning with `=`, `+`, `-`, `@`, tab or carriage
return is executed as a formula when the file is opened in Excel or Sheets. A
booking titled `=cmd|'/c calc'!A1` is a live attack on whoever opens the export.
Every such cell is prefixed with a single quote, which neutralises it and stays
readable.

**Structural integrity.** Every field is quoted and embedded quotes are doubled,
so a comma or newline inside an event title or refusal reason cannot shift
columns. Both behaviours are covered by unit tests in
`tests/unit/simulation.test.js`.

Exports are bounded (`limit`, max 5000) and go through the same service as the
API, so when authentication is added the export inherits it rather than becoming
a side door.

## 8. Known limits

- Query plans have not been measured on a realistic data volume (section 5).
- Rejection rule classes are derived from free-text refusal reasons with `ILIKE`
  patterns. A structured `rejection_rule` column would be more robust; that is a
  schema change deliberately deferred rather than bolted on here.
- Views are computed on read. At present volumes this is correct and avoids
  staleness; materialised views with a refresh schedule would become worth it
  only once the booking history is large enough for the merge-and-sweep queries
  to be felt, which has not been measured.
