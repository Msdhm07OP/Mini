# Scheduling algorithms

## Allocation policy

The required policy is applied in this order:

1. Compute the reserved interval `[event_start - 30 minutes, event_end + 30 minutes)`.
2. Verify the full interval falls within 08:00–22:00.
3. Search the preferred venue first.
4. At that venue, evaluate active halls with sufficient capacity in ascending capacity order, then hall ID for deterministic tie-breaking.
5. Reject a hall candidate if its reserved interval overlaps a confirmed booking.
6. Check all shared resource types for the entire reserved interval.
7. If no feasible hall/resource combination exists at the preferred venue, inspect the other venues in ascending venue ID order and apply the same hall/resource checks.
8. If no candidate can satisfy all constraints, persist a rejected or waitlisted request with an explanation.

The decision is deterministic for a fixed database state. It is **preferred-venue-first**, not globally smallest-hall-first across all venues; this preserves the stated problem requirements.

## Interval overlap

Intervals use the half-open convention `[start, end)`. Two intervals overlap if:

`A.start < B.end AND B.start < A.end`

Thus `[09:30, 11:30)` and `[11:30, 13:00)` do not overlap. Setup/cleanup buffers are included in the interval sent to both application and database checks.

## Shared-resource sweep line

For each candidate and each overlapping confirmed booking, create two time events: start (`+ quantity`) and end (`- quantity`). Sort by time, process end boundaries before start boundaries at equal times, and maintain a running total for projectors, audio systems, and staff. If any running total exceeds the relevant venue capacity, the candidate is infeasible.

Let `n` be the number of overlapping reservations and `r` the fixed number of resource types (3 here). Sorting interval boundaries takes `O(n log n)` time; scanning the sorted boundaries takes `O(nr)`, which is `O(n)` for a fixed resource catalog. Storage is `O(n)`.

## Hall search complexity

Let `V` be the number of venues, `H` the number of candidate halls in a venue, and `n` the number of overlapping reservations returned for a candidate. This implementation checks venues/halls sequentially and performs availability/resource queries for candidates until one works. In the worst case there are `O(VH)` candidate checks, each requiring database queries and a sweep over relevant overlapping reservations. Indexes on venue/date/status and hall/date/status reduce the candidate sets; real runtime depends on database latency and event density.

## Alternatives and recurring series

Alternative slots are read-only projections: each nearby time is validated and checked without inserting a temporary booking. A returned suggestion must be confirmed through the normal booking transaction because availability can change after it is shown.

A recurring series evaluates all occurrences inside one transaction. With `all_or_nothing=true` (the default), any infeasible occurrence results in no booking records for that series; an audit event records why the series was not created. When partial series mode is explicitly requested, each feasible occurrence is confirmed and infeasible occurrences are recorded as rejected.

## Example

For an event from 10:00 to 12:00, the reserved hall/resource interval is 09:30–12:30. A second event starting at 12:00 still conflicts because it needs setup from 11:30; a second event starting at 13:00 reserves from 12:30 and can share the same hall because the half-open intervals touch but do not overlap.
