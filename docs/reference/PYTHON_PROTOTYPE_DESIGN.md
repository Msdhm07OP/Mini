# Design notes

## 1. Reading of the problem

Four things in the brief do most of the work, and three of them are easy to miss.

**The reserved interval is not the event.** Every booking holds its hall *and its
resources* from 30 minutes before the start to 30 minutes after the end. The brief's own
sample situation turns on this: a conference ending at 1:00 PM still holds the hall at
1:15 PM. All scheduling arithmetic therefore happens on the reserved interval, never on
the event times.

**Operating hours apply to the reserved interval too.** A 9:45 PM–10:00 PM event is
illegal, because clearing would run to 10:30 PM. The legal event window is 8:30 AM–9:30 PM.

**Resources are pooled per venue, not per hall.** Two events in two different halls at
venue A compete for the same two projectors and the same five staff. This makes resource
availability a load problem over a time window, not a yes/no flag.

**"Available for its full reserved interval" means at every instant.** A resource can be
free when your event starts and unavailable twenty minutes later. Checking the start
instant is the obvious implementation and it is wrong.

## 2. Data model

Times are stored as integer minutes from midnight (`start_min`, `end_min`) against a
`event_date`. Overlap becomes `a_start < b_end and b_start < a_end` — two integer
comparisons, no timezone or floating point involved, and trivially indexable.

```
venues   (id, name, projectors, audio_systems, staff)
halls    (id, venue_id, capacity)
clients  (id, name, organisation, email, phone)
bookings (id, client_id, title, event_date, start_min, end_min, attendees,
          preferred_venue_id, req_projectors, req_audio_systems, req_staff,
          venue_id, hall_id, status, series_id, reason, created_at)
decision_log (id, booking_id, action, outcome, detail, created_at)
```

A booking row is the whole lifecycle: a refused request is kept with
`status = REJECTED` and a reason, so the client can later be put on the waitlist without
re-entering anything, and so refusals are analysable. Cancellation nulls `hall_id` and
`venue_id`, which is what "releases the resources" means — the allocator only ever reads
rows with `status = CONFIRMED`.

Index `(venue_id, event_date, status)` serves the only query the allocator makes.

## 3. The allocation algorithm

`allocate(session, demand, exclude_ids)` is a pure function of the current confirmed
bookings. It never writes. That single decision is what makes it reusable for booking,
rescheduling, waitlist replay, suggestion testing and unit tests.

```
check operating hours on [start-30, end+30]        → refuse with the legal window
for venue in [preferred] + [others sorted by id]:
    halls ← {h in venue : h.capacity ≥ attendees}  sorted by (capacity, id)
    if halls empty                                 → note "largest hall seats X"
    neighbours ← confirmed bookings at venue on date, overlapping the interval
    for each resource kind requested:
        if requested > venue stock                 → note "venue owns N in total"
        peak ← sweep(neighbours, interval)
        if peak + requested > stock                → note the window and who holds it
    for hall in halls:
        if no neighbour occupies hall              → allocate and return
    note which halls are held, and by what
refuse, summarising the blocker that actually applied
```

**Hall choice is best fit:** the smallest hall that seats the guests, ties broken by hall
id ascending. Best fit keeps large halls open for large events; the id tiebreaker makes
the result deterministic, which matters for a system people have to trust and for tests.

**Venue order** is preferred first, then remaining venues by id. Note the consequence,
which is deliberate and matches the brief: if the preferred venue has *any* feasible
hall, it is used even when another venue would fit more snugly. The spec says to search
other venues only when the preferred one has nothing feasible.

**Check order** is cheapest and most decisive first: hours, then venue stock (a static
comparison), then capacity, then the sweep, then hall occupancy.

### The sweep line

For one resource kind, each overlapping booking contributes a `Load(start, end, amount)`.
Every boundary inside the query window is a cut point; between two consecutive cut points
the set of active bookings cannot change, so one sample per segment is exact.

```
cuts  ← {window_start, window_end} ∪ {boundaries inside the window}
peak  ← max over consecutive segments of Σ amount of loads covering that segment
```

Complexity: O(n log n) to sort the cuts, O(n) per segment in the straightforward
implementation used here — fine for n in the tens, which is one venue on one day. If the
load grew, the same cut points can be swept once with a running counter for O(n log n)
overall; the interface would not change.

The sweep also returns *which* window was the worst and *which bookings* were holding the
resource, which is what turns a refusal into a sentence a client can act on:

> Venue A (preferred) — 0 of 5 support staff free between 11:00 AM and 1:30 PM, 2
> requested (held by Annual analytics conference, Design systems workshop)

### Worked example — the brief's sample situation

Venue A has A1 (60), A2 (150), 2 projectors, 2 audio systems, 5 staff.

| # | Request | Reserved | Decision |
|---|---|---|---|
| 1 | Conference, 120 guests, 10:00–1:00, 1 projector, 3 staff | 9:30–1:30 | **A2** — only hall seating 120 |
| 2 | Workshop, 50 guests, 11:00–2:00, 1 projector, 2 staff | 10:30–2:30 | **A1** — best fit; peaks reach 2/2 projectors and 5/5 staff, exactly at capacity |
| 3 | Product launch, 100 guests, 1:15–3:15, 1 projector, 2 staff | 12:45–3:45 | **B1 at venue B** |

The third is the interesting one. At venue A both projectors and all five staff are
committed until 1:30 PM, and A2 is still in its clearing buffer, so venue A cannot take
it on resources *or* on halls. Venue B is next by id and B1 (100) is the smallest hall
there that seats 100. Both of the first two requests are confirmable together — the
answer to the brief's question — and the third is confirmable only by leaving venue A.

## 4. Changes

**Cancellation** sets `status = CANCELLED` and clears the allocation, then immediately
replays the waitlist.

**Rescheduling** re-runs every constraint with `exclude_ids = (this booking,)`. Without
that exclusion a booking moved by fifteen minutes would conflict with its own current
hold — a bug that is easy to ship and hard to notice. Nothing is written unless the new
slot clears every check, so a failed reschedule provably leaves the original intact
(`test_failed_reschedule_leaves_the_original_untouched`).

**Concurrency.** Two coordinators submitting the last projector at the same instant must
not both succeed. SQLite is opened with `BEGIN IMMEDIATE`, so the write lock is taken at
the start of the transaction rather than at first write: the second request blocks, then
re-reads a world in which the first booking exists and is refused correctly. On
PostgreSQL the same guarantee comes from `SERIALIZABLE` or a row lock on the venue.

## 5. The additional features

**Alternative-slot suggester.** Brute-forcing every 15-minute slot works but repeats
identical work: nothing changes between two booking boundaries. Candidates are therefore
the first legal start of the day, plus — for each existing booking — starting as its hold
ends, and finishing as its hold begins. That is at most 2k+1 candidates for k bookings.
Each is run through the real allocator, so a suggestion is a slot the engine has already
agreed to, not an estimate. Same-day options are sorted by distance from the requested
time, then the following three days are tried at the original time.

**Waitlist.** Strictly first-come-first-served by request time. A later request never
takes a slot that an earlier waiting request could have used, even though that sometimes
leaves a hall emptier than a greedy fill would. Fairness is worth more than utilisation
when clients can see the queue. Each promotion is flushed before the next is tested, so
the queue sees a truthful picture of what remains.

**Weekly series.** All-or-nothing by default, inside one transaction: a six-week course
missing week four is worth nothing to the client. Failures are reported per date so the
client knows exactly which weeks are the obstacle.

**Decision log.** Every accept, refusal, cancellation, reschedule attempt and promotion
is written with its reasoning. Refused reschedules are logged too — the attempt is part
of the record even though the booking did not move.

## 6. Known limits

- Single-process SQLite. The locking strategy is correct but the throughput ceiling is
  low; PostgreSQL is a drop-in change at the engine URL plus the isolation note above.
- The waitlist is replayed on release, not on a schedule, so a request waiting for a date
  that frees up through some other path is only re-tested at the next release.
- No authentication or per-client accounts; the brief scopes this as an internal tool.
- Resource identity is not tracked — projectors are counted, not individually assigned,
  which is what the brief's dataset describes.

## 7. Questions we expect

**Why not first fit for halls?** First fit would put a 50-guest workshop in a 250-seat
hall if it came first, and block the only hall that can hold an exhibition. Best fit
keeps large halls free for events that need them.

**Why integer minutes rather than timestamps?** Exact comparisons, no timezone handling,
and the overlap test stays two comparisons. Dates are a separate column because every
booking is within a single day by construction.

**What if an event spans midnight?** It cannot: operating hours close at 10:00 PM, so the
constraint is enforced upstream of the data model.

**Why check resources before hall occupancy?** Resources are a venue-level property, so
one sweep answers for all halls, while hall occupancy must be tested per hall. Doing the
cheaper, more general check first avoids per-hall work that a venue-level shortage would
have invalidated anyway.

**What stops a double booking under load?** `BEGIN IMMEDIATE` plus re-reading inside the
transaction. See §4.

**How would this scale to 50 venues?** The query is already scoped to one venue on one
day. The per-venue loop is independent, so it parallelises; the sweep is per venue and
per day, so it does not grow with the size of the company.
