# Testing and benchmarks

## Unit tests

Run from `backend/`:

```bash
npm test
```

Unit tests cover buffer calculations, operating-hour boundaries, half-open overlap semantics, shared-resource sweep-line capacity, and simultaneous end/start boundaries.

## PostgreSQL integration checks

Set `TEST_DATABASE_URL` in `backend/.env`, run `npm run migrate` and `npm run seed` with the database connection set to that test database, then run:

```bash
npm run test:integration
```

The integration test verifies the six required halls/capacities, the hall overlap exclusion constraint, and the resource-utilization view. Without a database URL, it is skipped rather than falsely reported as passed.

## Concurrency regression test

```bash
npm run test:concurrency
```

This standalone script sends 100 simultaneous service-level booking requests to a single date/slot, then inspects overlapping confirmed hall reservations and resource-utilisation segments. It deletes only bookings marked by its unique run ID at the end; associated audit events are retained. Run it only against a disposable test database.

## HTTP load test

Seed a dedicated test database. Start the API with `npm run dev:testdb` so it uses `TEST_DATABASE_URL`, then run:

```bash
# From backend/; use a dedicated test database
RATE_LIMIT_MAX_REQUESTS=1000 npm run load:test
```

Optional environment settings:

- `TARGET_URL` — defaults to `http://localhost:3000/api/v1/bookings`
- `CONCURRENCY` — defaults to `100`, maximum `1000`
- `CLIENT_ID`, `VENUE_ID` — default to the first active client and first venue
- `EVENT_DATE` — if omitted, the script chooses a future date to reduce collisions with prior test runs
- `EVENT_START`, `EVENT_END`, `ATTENDEES`, `PROJECTORS`, `AUDIO_SYSTEMS`, `STAFF`
- `REQUEST_TIMEOUT_MS`
- `CLEANUP_LOAD_TEST=true` — deletes the bookings created by the current run; audit events remain

The script measures request throughput, elapsed time, p50/p95/p99 request latency, response status counts, unexpected errors, hall-overlap invariants, and resource-overcapacity segments. It writes test bookings unless cleanup is enabled. Use a test/staging database, not production. The local rate limiter counts requests by IP, so raise its threshold for this benchmark in that isolated environment.

## Benchmark reporting template

Do not write numbers into project documentation until you have run the script against a live target. Record:

- Date/time and test environment.
- Node version, PostgreSQL provider/version, connection pool size, and API host size.
- Concurrency and request mix.
- Requests/sec and total duration.
- p50/p95/p99 latency.
- Confirmation / waitlist / rejection counts.
- HTTP 5xx/timeouts.
- Confirmed hall overlap count.
- Resource-overcapacity segment count.

A result is useful only if the test was actually run. This repository intentionally makes no measured throughput claim before configuration and execution.
