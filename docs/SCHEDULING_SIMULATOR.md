# Explainable scheduling simulator

`backend/src/services/simulationService.js`, exposed at `POST /api/v1/simulations`,
with the operator interface at **What-If Planner** in the frontend.

## What it answers

"If we accepted these three enquiries, what would actually happen?" — without
booking anything. An operator fielding several tentative enquiries can see which
would fit, which venue each would land in, and which would be refused and why,
before committing to any of them.

## Three properties that make it trustworthy

**It writes nothing.** No temporary bookings, no reserved resources, no audit
events. Creating a provisional booking to test availability is the obvious
implementation and it is wrong: it pollutes the decision log, it races against
real traffic, and a crash mid-simulation leaves phantom holds. Every result is
computed in memory and discarded.

**One consistent snapshot.** Venues, halls, capacities and confirmed bookings
are read inside a single `REPEATABLE READ READ ONLY` transaction, so every
hypothetical in a scenario is judged against the same picture of the schedule
rather than a target moving under concurrent bookings.

**Hypotheticals compete with each other.** This is the part most simulators get
wrong. Each accepted hypothetical is added to the working snapshot before the
next is evaluated, so two simulated events that would together exhaust a venue's
projectors are reported as one accepted and one pushed elsewhere — not both
accepted because each looked fine in isolation.

## The policy is the production policy

The simulator does not reimplement scheduling. It imports
`evaluateResourceCapacity` from `utils/resourceSweep.js` — the same module the
booking path uses — so the resource mathematics is literally the same code.
Venue order (preferred first, then by id), smallest sufficient hall, hall id as
tie-breaker, half-open intervals and the 30-minute buffers all match. A
simulated acceptance is therefore a genuine prediction rather than an estimate
from a parallel implementation that can drift.

## What it returns

Per request: the verdict, the reserved interval, and `candidates` — the decision
trail in the order the algorithm considered venues. Each entry records the
outcome and a human-readable reason:

- `hall_capacity` — largest hall at that venue is too small
- `hall_conflict` — halls big enough exist but are held during the interval
- `shared_resources` — equipment or staff peak above capacity, with the time and
  the holding bookings named
- `selected` — which hall was chosen, how much capacity it wastes, and which
  other free halls were larger

Rejections distinguish "no hall anywhere is big enough" from "the right hall is
busy", because those are different problems with different fixes.

## Measured example

Against the seeded database holding the brief's sample situation, a scenario of
three hypotheticals at Venue A:

```
summary: {"requested": 3, "accepted": 2, "rejected": 1,
          "moved_from_preferred": 1, "blocking_rules": {"operating_hours": 1}}

[ACCEPT] Pharma summit:     Would be confirmed in A2 at Venue A, holding the hall 14:30-17:30.
[ACCEPT] Investor briefing: The preferred venue could not take it, so it would fall
                            through to B2 at Venue B.
[REJECT] Late gala:         With 30-minute setup and cleanup buffers this request holds
                            its hall 20:30-22:30, which falls outside operating hours
                            08:00-22:00.

bookings in database before: 3    after: 3
```

The second result is the feature working. The Investor briefing would fit at
Venue A on its own; it is pushed to Venue B because the *first hypothetical in
the same scenario* took both of Venue A's projectors.

## Limits

- Requests are evaluated in the order supplied, first-come-first-served. It does
  not search for the globally optimal packing of a scenario; that is a different
  (and much more expensive) problem, and an operator usually wants to know the
  consequence of a stated priority order.
- Scenarios are capped at 25 requests.
- Results are a prediction against a snapshot. A real booking placed a second
  later can invalidate them, which is why the authoritative booking path rechecks
  every constraint inside its own transaction and the UI labels results
  hypothetical throughout.
