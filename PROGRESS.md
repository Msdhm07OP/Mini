# EventSync 3.0 — progress report

Updated 30 October 2026. Records what was built and verified, and what was not,
so nothing here has to be taken on trust.

## Follow-up update — EventSync 3.0 expansion

The codebase has since been extended beyond the baseline measurements below. The
baseline test results in this file describe the earlier implementation and do not
verify the new Supabase migration set or UI additions.

### Added in this update

- Supabase Auth bearer-token verification in the Express API, database-backed roles
  (`admin`, `manager`, `staff`, `client`), protected routes, and a server-startup
  guard that prevents production startup without configured Auth.
- Supabase CLI configuration, a core/analytics migration chain, a migration for
  user profiles and digital event orders, and a migration defining RLS policies and
  transactional SQL RPC functions for creating, cancelling, rescheduling, promoting
  the waitlist, and creating recurring booking series.
- Booking-service switching controlled by `BOOKING_ENGINE` so the pre-existing
  JavaScript transaction engine remains the local default while SQL RPC mode is
  opt-in after Supabase setup.
- A staff portal for digital event orders (BEOs), including AV/setup/catering and
  accessibility notes, a run-of-show, a setup checklist, optimistic version checks,
  and print styling.
- Supabase setup documentation, configuration examples, and updates to the main
  README.

### Current update file map

| Area | Files |
|---|---|
| API authentication and roles | `backend/src/middleware/supabaseAuth.js`, `backend/src/controllers/AuthController.js`, `backend/src/routes/v1/auth.js`, `backend/src/server.js` |
| Database and RPC | `backend/src/database/migrations/003_security_and_event_orders.sql`, `supabase/migrations/`, `supabase/config.toml`, `supabase/seed.sql`, `backend/src/services/supabaseRpc.js`, `backend/src/services/schedulingService.js` |
| Event order API | `backend/src/controllers/EventOrderController.js`, `backend/src/routes/v1/eventOrders.js` |
| Frontend authentication and staff workflow | `frontend/src/services/auth.js`, `frontend/src/services/api.js`, `frontend/src/components/AuthShell.jsx`, `frontend/src/components/StaffPortal.jsx`, `frontend/src/App.jsx`, `frontend/src/index.css` |
| Operator documentation | `docs/SUPABASE_SETUP.md`, `docs/FEATURE_ROADMAP.md`, `README.md`, `PROGRESS.md` |

## Pre-Supabase validation follow-up

A further static validation pass found and fixed three issues in the Supabase SQL path: malformed booking payloads are now rejected before insert; idempotency lookup occurs before time-sensitive validation; and expired idempotency-key reuse updates the request hash. The versioned migration and all-in-one SQL were updated together.

The current environment could parse 53 JavaScript/JSX files with zero syntax diagnostics, find no missing relative imports, pass three independent resource-sweep smoke checks, and confirm that the all-in-one SQL mirrors the four migrations and includes RLS enablement for all 12 application tables. These are static/logic checks, not proof that PostgreSQL accepts or executes the migration.

See `docs/PRE_SUPABASE_VALIDATION.md` for the full list of checks and blockers. No PostgreSQL executable/server or project `node_modules` were available in this environment, and external DNS resolution failed; therefore SQL execution, Jest suites, and a fresh Vite production build remain unverified.

## Verification after this update

- All backend JavaScript source and test files passed `node --check` syntax checks.
- At this follow-up editing pass, no PostgreSQL executable/server was available to
  rerun the new Supabase SQL migrations, so they could not be applied or executed here.
- Installing frontend dependencies was blocked in the environment; therefore a fresh
  frontend production build could not be completed after adding the new UI.
- The baseline unit, integration and concurrency measurements below were not rerun
  after the update. They must not be interpreted as tests of the new Auth/RLS/RPC or
  digital event-order code.

## Environment

PostgreSQL 16.15 was installed in this container, so for the first time the
migrations, integration tests and concurrency suite actually ran. Every result
below is real output, not an expectation.

## Defects found and fixed in the existing code

**Seed script failed outright.** `npm run seed` aborted with
`inconsistent types deduced for parameter $2`. The client upsert used `$2` both
in a `SELECT` list and in `WHERE email = $2`, and PostgreSQL could not reconcile
the two deduced types. Fixed with explicit `::varchar` casts. The project's own
README documented the seed as working; it had never been run.

**Join fan-out in the seed summary.** After fixing the above, the summary
printed every hall three times — halls joined to venues joined to three resource
rows each. The stored data was correct (6 halls, 3 venues, 9 capacity rows);
only the report was wrong. Rewritten with two `LATERAL` subqueries so hall
aggregation and resource aggregation do not multiply each other.

Both are the kind of defect that only surfaces against a real database, which is
why installing one mattered more than writing more documentation.

## Measured results

```
npm test                  20 passed, 5 suites (was 10 passed, 1 skipped)
npm run test:integration  1 passed — seeded dataset matches the brief exactly
npm run migrate           001 and 002 applied cleanly
npm run seed              venues A/B/C with correct halls and resource pools
frontend npm run build    1426 modules, 272 kB JS (84 kB gzipped)

npm run test:concurrency
  Same slot:                    100 requests, 5 confirmed, 95 controlled rejections, 0 errors, 1738 ms
  Shared-resource contention:   100 requests, 5 confirmed, 95 controlled rejections, 0 errors, 1242 ms
  Hall overlap conflicts:       0
  Resource-overcapacity segments: 0
  PASS: no booking/resource invariants were violated
```

The brief's sample situation, created through the HTTP API:

```
Annual analytics conference (120 guests, 10:00-13:00)  -> Venue A / A2
Design systems workshop     (50 guests,  11:00-14:00)  -> Venue A / A1
Series 4 product launch     (100 guests, 13:15-15:15)  -> Venue B / B1

Venue A projector:     peak 2/2 = 100%
Venue A support_staff: peak 5/5 = 100%
```

Venue A is fully committed on both projectors and staff, which is exactly why
the launch overflowed to Venue B — the analytical confirmation of the scenario
in the problem statement.

## Features added

**What-if scheduling simulator** (`POST /api/v1/simulations`, "What-If Planner"
tab). Read-only multi-request planning against a `REPEATABLE READ` snapshot.
Hypotheticals compete with each other, not just with existing bookings, and each
result carries the per-venue decision trail. It imports the production sweep-line
module rather than reimplementing it. Verified: a scenario of three requests
returned 2 accepted / 1 rejected, the second accepted request was pushed to
Venue B because the first took Venue A's projectors, and the booking count was 3
before and 3 after.

**SQL analytics layer** (migration 002, `/api/v1/analytics/*`, "Analytics" tab).
Seven views covering request outcomes, hall and venue utilisation, peak resource
demand, demand heatmap, rejection analysis and lifecycle trends. Utilisation
merges overlapping intervals via islands-and-gaps so no minute is counted twice;
peak demand is a SQL sweep line that processes interval ends before starts so
back-to-back holds produce no phantom spike. Every response states its
denominator and the UI displays it.

**Data-quality monitoring** (`/api/v1/analytics/data-quality`). Ten read-only
checks: orphaned allocations, confirmed bookings without halls, cancelled
bookings still holding resources, capacity violations, invalid intervals, holds
outside operating hours, buffer mismatches, missing audit history and
unexplained refusals. Each finding carries severity, entity, id, detail and a
recommended action. It never repairs or deletes. Current status: 0 findings.

**CSV export** (`/api/v1/analytics/export/:dataset`). Six whitelisted datasets.
Cells starting with `=`, `+`, `-`, `@`, tab or CR are prefixed with a quote to
neutralise formula injection; all fields are quoted and embedded quotes doubled.
Both behaviours are unit-tested.

**Frontend.** Two new pages wired into the existing navigation, reusing the
existing API client and Tailwind conventions. No existing page was modified
beyond adding the two tabs.

## Files changed — prior analytics/simulator update

| File | Change |
|---|---|
| `backend/src/database/seed.js` | fixed parameter-type bug and join fan-out |
| `backend/src/database/migrations/002_analytics_and_data_quality.sql` | new — 7 analytics views, data-quality view, 4 indexes |
| `backend/src/services/simulationService.js` | new — what-if simulator |
| `backend/src/services/analyticsService.js` | new — analytics queries, CSV serialisation |
| `backend/src/services/validation/schemas.js` | added simulation schema |
| `backend/src/controllers/AnalyticsController.js` | new |
| `backend/src/routes/v1/analytics.js`, `simulations.js` | new |
| `backend/src/server.js` | mounted the two new route groups |
| `backend/tests/unit/simulation.test.js` | new — 9 tests |
| `frontend/src/components/Simulator.jsx`, `Analytics.jsx` | new |
| `frontend/src/services/api.js` | analytics, simulation and CSV download clients |
| `frontend/src/App.jsx` | two new tabs |
| `docs/DATA_ENGINEERING_REPORT.md`, `docs/SCHEDULING_SIMULATOR.md` | new |
| `README.md` | verification status, new endpoints, honest gaps |

No existing endpoint, schema object or component was renamed or removed.
Migration 002 is additive only: views and indexes, no table altered.

## Frontend polish added in 3.1

- Reworked the app shell into a responsive grouped sidebar and contextual top bar.
- Added a keyboard command palette, mobile drawer, and keyboard Escape behavior.
- Refreshed dashboard metrics, utilization bars, empty/error states, and shimmer loading skeletons.
- Added restrained page, button, navigation, metric, and auth-card transitions with reduced-motion support.
- See `docs/FRONTEND_DESIGN_NOTES.md` for details. Static JS/JSX and CSS parsing passed; a Vite build remains unverified because dependencies could not be installed from the offline npm cache.

## Not done / not yet verified

The largest architectural gaps have been addressed in code, but still need a real
Supabase deployment and validation before they can be considered complete:

- **Supabase migration and RLS verification.** The migration chain is authored, but
  it has not been applied to a fresh Supabase project or exercised with separate
  admin, manager, staff and client users. Review the migration chain before using it
  against any database that already contains EventSync tables.
- **Auth and Google OAuth end-to-end verification.** The login UI and backend token
  verification are implemented. Configure Google in the Supabase dashboard and
  verify redirect URLs, session refresh, sign-out and role assignment.
- **SQL RPC correctness and concurrency verification.** The booking RPC functions
  have been written and the backend can opt into them, but the functions have not
  been run against PostgreSQL in this environment. The JavaScript engine remains the
  default until the SQL path is verified.
- **Frontend production build.** Not rerun because dependency installation was
  blocked in the current environment.
- **Individual equipment assets and preventive maintenance.** Allocation still uses
  counted resource pools; serialised asset tracking and maintenance blocks are not
  integrated into the scheduler.
- **Offline staff mode and queued synchronization.** The staff portal requires a
  live connection.
- **Structured rejection reasons.** Refusal reasons remain free text plus a rejection
  code; analytics still classifies some reasons with pattern matching.
- **Performance.** Query plans on realistic data volumes and the HTTP load test have
  not been measured.

## Recommended next steps

1. Apply the Supabase migrations to a fresh development project, review the SQL,
   and run integration checks before enabling `BOOKING_ENGINE=sql_rpc`.
2. Configure Supabase Auth, promote the first administrator, link client users to
   `public.clients`, and validate role-specific access using separate test accounts.
3. Reinstall frontend dependencies and build the React application; run the backend
   unit, integration and concurrency suites against an isolated test database.
4. After security and RPC verification, continue with per-asset equipment/maintenance
   tracking and offline-capable staff operations if those remain in the project scope.


## Database setup bundle update

Added `supabase/SUPABASE_SETUP_ALL_IN_ONE.sql` for a brand-new Supabase project, `supabase/DATABASE_SETUP.md` for dashboard/CLI setup steps, and `supabase/BOOTSTRAP_FIRST_ADMIN.sql` for promoting the first trusted administrator after signup. Supabase seed data now includes the five demo clients used by the existing local seed. These assets have not been executed against a hosted Supabase project; database/RLS/RPC integration still requires validation in a configured project.
