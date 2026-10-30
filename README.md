# EventSync — Merged Scheduling & Resource Management App

EventSync is a database-backed web application for scheduling client events across multiple venues while respecting hall capacity, venue operating hours, setup/cleanup buffers, and shared equipment/staff limits.

This merged project uses the React/Express/PostgreSQL application as its single active stack and incorporates useful scheduling/product ideas from the Python prototype: an operations timeline, chronological waitlist, recurring bookings, alternative-slot suggestions, and a decision/audit log.

> **Verification status:** the original PostgreSQL booking engine, analytics, seed, unit tests, integration test and 100-request concurrency suite have recorded passing results in `PROGRESS.md`. Static pre-Supabase checks were completed for this updated source, and two booking/RPC validation issues plus one idempotency issue were corrected. The new Supabase SQL has **not** been executed against PostgreSQL or a live Supabase project, and the frontend production build could not be rerun in this environment. See `docs/PRE_SUPABASE_VALIDATION.md` and `docs/SUPABASE_SETUP.md` before deployment.

> **Local development:** with Supabase variables left blank, the UI/API retain a clearly labeled local-demo mode for development. This mode is unauthenticated and must never be exposed publicly. In production, the backend refuses to start without Supabase Auth configuration.

## What is included

- React + Vite interface with dashboard, booking form, booking list, operations timeline, waitlist, decision log, what-if planner, analytics, and a staff portal with printable digital event orders (BEOs).
- Express API with validation, consistent errors, correlation IDs, rate limiting, security headers, and health check.
- PostgreSQL schema and versioned migration with foreign keys, constraints, indexes, status history, audit events, idempotency storage, and analytics views.
- Preferred-venue-first, smallest-sufficient-hall allocation with deterministic venue/hall ordering.
- 30-minute setup and cleanup buffers; 08:00–22:00 operating window.
- Transactional cancellation/rescheduling and FIFO waitlist promotion.
- Recurring series creation (all-or-nothing by default).
- Read-only alternative-slot search; suggestions do not create temporary bookings.
- Unit tests, database integration checks, a concurrency regression script, and an HTTP load-test script.
- **What-if scheduling simulator** — read-only multi-request planning that evaluates hypothetical events against the live schedule and against each other, with a per-venue decision trail. See `docs/SCHEDULING_SIMULATOR.md`.
- **SQL analytics layer** — utilisation, peak resource demand, demand heatmap, rejection analysis and lifecycle trends, aggregated in database views with stated denominators. See `docs/DATA_ENGINEERING_REPORT.md`.
- **Data-quality monitoring** — ten read-only checks for orphaned allocations, over-allocated resource pools, buffer mismatches and missing audit records.
- **CSV exports** with formula-injection protection for bookings, allocations, audit history, utilisation, resource demand and data-quality findings.
- Supabase Auth middleware with verified bearer-token handling and database-backed role checks (`admin`, `manager`, `staff`, `client`).
- Supabase migrations for Row Level Security (RLS), invoker-security analytics views, and database RPC entry points for create/cancel/reschedule, waitlist promotion, and recurring booking series.
- Digital event orders with setup/AV/catering/accessibility notes, a structured run-of-show, a versioned setup checklist, optimistic concurrency checks, and print-ready BEO layout. See `docs/SUPABASE_SETUP.md`.

## Frontend interaction polish (3.1)

The frontend uses a responsive operations layout with grouped sidebar navigation, a searchable destination palette (`Ctrl+K` / `Cmd+K`), an animated dashboard summary, improved loading and retry states, polished button feedback, and reduced-motion support. Existing booking, operations, analytics, simulator, and staff pages remain the underlying workflows. See `docs/FRONTEND_DESIGN_NOTES.md` for the design rationale and validation status.

## Project structure

```text
EventSync_Merged/
├── backend/
│   ├── src/
│   │   ├── controllers/        # HTTP controllers
│   │   ├── database/          # PostgreSQL pool, migration runner, seed, SQL migrations
│   │   ├── repositories/       # SQL persistence operations
│   │   ├── routes/v1/          # API routes
│   │   ├── services/           # Scheduling, validation, idempotency
│   │   └── utils/              # Time and sweep-line helpers
│   └── tests/                  # Unit, integration, concurrency, load tests
├── frontend/
│   └── src/components/         # React UI, AuthShell, staff event-order portal
├── supabase/
│   ├── migrations/             # Core schema, analytics, event orders, Auth/RLS and RPC
│   ├── seed.sql                # Original Venue A/B/C dataset
│   └── config.toml
├── docs/                       # Architecture, schema, algorithms, concurrency, analytics, tests, Supabase setup
└── EventSync_Hackathon_Problem_Statement.pdf
```

`docs/reference/` keeps selected Python-prototype algorithm/design notes for reference only; the running application does not require Python.

## Requirements

- Node.js 18 or newer
- npm 9 or newer
- PostgreSQL 13 or newer for the existing local backend
- A Supabase project and Supabase CLI for the Auth/RLS/RPC deployment path (optional for local demo mode)

## Run locally

### 1. Configure PostgreSQL

Create a local PostgreSQL database, then copy `backend/.env.example` to `backend/.env`. Set `DATABASE_URL` to the database connection URI.

Run `npm run migrate:status` to check which migrations are applied. There is intentionally no automatic destructive rollback command; use reviewed migrations when changing the schema. For a local PostgreSQL instance without TLS, set `DB_SSL=false`. For a hosted provider that requires TLS, keep `DB_SSL=true` and configure its connection details. Do not commit `.env` or paste database credentials into the frontend.

### 2. Install and initialise the backend

```bash
cd backend
npm install
npm run migrate
npm run seed
npm run migrate:status
npm run dev
```

The API runs on `http://localhost:3000`. The health endpoint is `http://localhost:3000/health`.

The seed is non-destructive: it upserts the official venue, hall, resource-capacity data and sample clients without deleting bookings.

### 3. Run the frontend

In a second terminal:

```bash
cd frontend
npm install
npm run dev
```

Open `http://localhost:5173`. Vite proxies `/api` requests to the backend on port 3000. `VITE_API_BASE_URL` can override the API base URL if needed; see `frontend/.env.example`.

## API overview

The active API is versioned under `/api/v1` (the same handlers are also mounted at `/api` for frontend compatibility).

- `GET /api/v1/venues`
- `GET /api/v1/clients`
- `POST /api/v1/clients`
- `GET /api/v1/bookings`
- `POST /api/v1/bookings`
- `GET /api/v1/bookings/stats`
- `POST /api/v1/bookings/alternatives`
- `POST /api/v1/bookings/series`
- `POST /api/v1/bookings/:id/cancel`
- `POST /api/v1/bookings/:id/waitlist`
- `PUT /api/v1/bookings/:id/reschedule`
- `GET /api/v1/bookings/waitlist`
- `GET /api/v1/bookings/decisions`
- `GET /api/v1/auth/me` — verified session and EventSync role
- `GET /api/v1/event-orders?event_date=YYYY-MM-DD`
- `GET /api/v1/event-orders/:bookingId`
- `PUT /api/v1/event-orders/:bookingId` — save BEO fields and setup checklist with optional version conflict detection

Analytics, data quality and simulation:

- `GET /api/v1/analytics/overview`
- `GET /api/v1/analytics/outcomes`
- `GET /api/v1/analytics/hall-utilisation`
- `GET /api/v1/analytics/venue-utilisation`
- `GET /api/v1/analytics/resource-demand`
- `GET /api/v1/analytics/demand-heatmap`
- `GET /api/v1/analytics/rejections`
- `GET /api/v1/analytics/lifecycle`
- `GET /api/v1/analytics/data-quality`
- `GET /api/v1/analytics/export/:dataset` — csv; dataset is one of `bookings`, `allocations`, `audit`, `hall-utilisation`, `resource-demand`, `data-quality`
- `POST /api/v1/simulations` — read-only what-if evaluation; creates nothing

All analytics endpoints accept `date_from`, `date_to`, `venue_id` and `limit`, and return a `definition` field stating how each metric is calculated.

See `docs/ARCHITECTURE.md`, `docs/SUPABASE_SETUP.md`, `docs/FEATURE_ROADMAP.md`, and the controller files for request/response details.

## Tests and verification

Run commands from `backend/`:

```bash
npm test                    # database-free unit tests; PostgreSQL integration test is skipped without a DB URL
npm run test:integration    # requires a migrated and seeded test database
npm run test:concurrency    # sends 100 simultaneous service-level booking requests; requires TEST_DATABASE_URL
npm run dev:testdb          # starts the API against TEST_DATABASE_URL
# In a second terminal: npm run load:test
```

For integration and stress tests, configure `TEST_DATABASE_URL` in `backend/.env` and run migrations/seed against that dedicated test database first. Test scripts refuse to run without it, to reduce the risk of modifying real booking data. Do not run stress scripts against production data.

The load test writes uniquely marked booking records. Start the test API with `npm run dev:testdb` so the API and invariant checks use `TEST_DATABASE_URL`. Set `CLEANUP_LOAD_TEST=true` to remove only the bookings created by that run; audit events are intentionally retained. Use `TARGET_URL`, `CONCURRENCY`, `CLIENT_ID`, `VENUE_ID`, and `EVENT_DATE` to customise a run. See `docs/TESTING_AND_BENCHMARKS.md`.

## Supabase database setup

For pre-Supabase checks and current verification limits, see [`docs/PRE_SUPABASE_VALIDATION.md`](docs/PRE_SUPABASE_VALIDATION.md). For a complete fresh-project setup, see `supabase/DATABASE_SETUP.md`. The easiest path is to create a new Supabase project and run `supabase/SUPABASE_SETUP_ALL_IN_ONE.sql` once in the dashboard SQL Editor. Use that **instead of** applying the versioned migrations; never use both on the same database. `supabase/BOOTSTRAP_FIRST_ADMIN.sql` shows how to promote your own signed-up user after the migrations run. These files prepare the database schema and seed data but do not create a hosted project in your account.

## Database and concurrency notes

- Hall conflicts are guarded by a PostgreSQL exclusion constraint on hall, date, and reserved interval.
- Booking writes use one transaction for allocation, state changes, resource allocations, audit events, and idempotency result storage.
- Allocation uses transaction-scoped advisory locks across venues for each affected date. This is conservative and prioritises correctness; measured load results should guide any future lock-granularity optimisation.
- Shared-resource availability is checked with a sweep-line algorithm using half-open intervals `[start, end)`, with end boundaries processed before starts.
- Availability previews are advisory only. Confirmation performs fresh checks inside the transactional workflow.

See `docs/CONCURRENCY_DESIGN.md` for the design and its trade-offs.

See [`docs/FEATURE_ROADMAP.md`](docs/FEATURE_ROADMAP.md) for the prioritized implementation and verification roadmap.

## Not yet implemented or not yet verified

- **Individual equipment assets and preventive maintenance.** Resources are still allocated as counted pools; specific serialised assets and maintenance blocks are not integrated into the booking allocator.
- **Offline staff mode and queued synchronization.** The new staff portal is online-only. It does not yet cache daily schedules or sync edits made offline.
- **Automated browser-verified Google OAuth and live Supabase flows.** The frontend includes password login and a Google provider entry point, but the provider/redirect setup and login must be verified in your Supabase project.
- **Live Supabase migration/RLS/RPC validation.** The Supabase migrations are authored but not applied or integration-tested against a real Supabase project in this update.
- **Structured rejection reasons.** Refusal reasons remain free text plus a rejection code; analytics still classifies some reasons with pattern matching.

## Known limitations

- Query plans have not been measured on a realistic data volume; analytics indexes are justified by query shape but not benchmarked at scale.
- The original concurrency suite is documented as passing against PostgreSQL 16.15, but it has not been rerun after this update.
- The load test (`npm run load:test`) has not been executed.
- Frontend dependency installation was blocked in the current environment, so the new frontend components have not had a fresh production build here.
- The SQL RPC migration should be reviewed/applied to a clean Supabase project and tested with separate admin/staff/client users before production deployment.
