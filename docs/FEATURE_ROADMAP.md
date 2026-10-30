# EventSync 3.0 — Feature Roadmap

This roadmap uses the original hackathon Problem Statement as the source of truth
for required behavior and the supplied *EventSync Innovative Feature Ideas* report
as a source of optional extensions. Current code, not this document alone, determines
whether a feature is implemented. New Supabase migrations and UI features added in
this update still require integration verification before deployment.

## Non-negotiable baseline

- Record clients and event requests, including the event date/time, attendance,
  preferred venue and requested shared resources.
- Prefer the requested venue first; within a venue, select the smallest suitable
  available hall, with deterministic tie-breaking. Fall back to other venues when
  necessary.
- Keep the entire reservation, including 30-minute setup and cleanup buffers,
  inside 08:00–22:00.
- Enforce shared projector, audio-system and support-staff capacity across all
  simultaneous bookings at the venue.
- Cancellation releases allocations. Rescheduling rechecks all constraints and
  must leave the original confirmed booking unchanged if the proposed allocation
  fails.
- Explain decisions and retain database-backed booking/audit records.

## Existing product capabilities

| Capability | Current status | Notes |
|---|---|---|
| Core booking allocation and change management | Implemented in the baseline application | Uses the existing JavaScript transaction engine by default. |
| Alternative time-slot suggestions | Implemented | Suggestions are read-only and do not reserve temporary slots. |
| Chronological waitlist and promotion logic | Implemented | Baseline implementation contains waitlist handling; SQL RPC promotion is additionally authored in this update. |
| Operations timeline / board | Implemented | A more advanced Gantt-style view remains a possible enhancement. |
| Decision log, audit records and analytics | Implemented | Includes utilisation, resource demand, rejection analysis and data-quality checks. |
| What-if scheduling simulator | Implemented | Evaluates hypothetical requests without creating bookings. |
| CSV exports | Implemented | Includes formula-injection protection. |

## Added in the current update

| Capability | Status | What is included |
|---|---|---|
| Supabase Auth integration | Implemented in code; not live-verified | Bearer-token verification, role lookup, sign-in UI and Google OAuth PKCE flow. |
| API authorization | Implemented in code; not live-verified | Roles are `admin`, `manager`, `staff`, and `client`; protected operations routes and a production Auth configuration guard. |
| RLS and database RPC | SQL authored; not execution-verified | RLS policies plus database entry points for booking creation, cancellation, rescheduling, waitlist promotion and recurring series. |
| Digital event orders / staff portal | Implemented in code; not build-verified | Setup/AV/catering/accessibility notes, run-of-show, setup checklist, event status, optimistic version checks and print layout. |
| Supabase setup and seed | Added | CLI config, core and analytics migration chain, official Venue A/B/C seed data and setup guide. |

## Recommended remaining work, in priority order

### P0 — Verify security and database invariants

1. Apply migrations to a fresh development Supabase project, read the generated SQL
   errors if any, and verify the final schema before using existing production data.
2. Test admin, manager, staff and client access with separate users. Confirm clients
   cannot read another client's bookings and cannot mutate role/profile mappings.
3. Run booking RPC tests for overlap conflicts, shared-resource contention, exact
   half-open boundaries, cancellation/waitlist promotion, failed rescheduling, and
   all-or-nothing recurring series. Run concurrency tests against a dedicated test DB.
4. Verify Google OAuth redirects, PKCE callback exchange, token refresh, sign-out and
   the production configuration guard. Rebuild the frontend from a clean install.

### P1 — Operational depth

- **Individual equipment assets and preventive maintenance:** model serialised assets,
  asset status and maintenance intervals; subtract unavailable assets from the relevant
  resource pool during the full reserved interval.
- **Gantt-style timeline improvements:** add resource lanes, setup/cleanup buffer bands,
  conflict highlighting and a way to filter by venue, hall and resource type while
  preserving the current operations board.
- **Change propagation:** surface booking updates/cancellations to staff and keep BEOs
  consistent. WebSocket or equivalent live updates are not implemented in this update.
- **Guided booking wizard:** collect event details progressively and explain why a
  request was rejected, including feasible alternatives.

### P2 — Resilience and scale

- Offline staff access with a local queue, conflict-aware synchronization and a clear
  indication of unsynced edits.
- Structured rejection codes instead of relying on free-text classification.
- Query-plan measurements on realistic data and an HTTP load test before tuning indexes
  or lock granularity.

## Verification boundary

Backend JavaScript syntax checks passed after the current update. The SQL migration set
has not been applied in this environment, and a fresh frontend production build could
not be completed because dependency installation was unavailable. Earlier test results
in `PROGRESS.md` are baseline results and do not verify this update's new code.

The source feature report is retained at
[`docs/reference/EventSync_Innovative_Feature_Ideas.pdf`](reference/EventSync_Innovative_Feature_Ideas.pdf).
