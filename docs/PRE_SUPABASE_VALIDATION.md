# EventSync 3.1 — Pre-Supabase validation report

## Scope

This report records checks performed on the updated source before creating or connecting a hosted Supabase project. It deliberately distinguishes source/static checks from PostgreSQL execution.

## Passed checks

- JavaScript/JSX parser check: **53 files parsed, zero syntax diagnostics** across `backend/` and `frontend/`.
- Backend JavaScript syntax check with Node.js `--check`: passed for all files under `backend/src/`.
- Relative import check: **zero missing relative imports** across the backend and frontend source files.
- Pure resource-allocation logic smoke checks: **3 passed** — resource demand within capacity, over-capacity rejection, and half-open interval boundaries where one reservation ends as another starts.
- SQL lexical scan: SQL string literals, quoted identifiers, dollar-quoted function bodies, and comments were balanced in the four migrations, all-in-one setup, seed, and admin bootstrap scripts.
- Migration/setup consistency: all four versioned migrations match the SQL content embedded in `SUPABASE_SETUP_ALL_IN_ONE.sql` (ignoring section-divider comments).
- RPC structure: exactly one definition was found for each of the five expected booking functions and the three core role/client helper functions checked.
- RLS coverage structure: RLS enablement statements are present for all **12 of 12** application tables listed by the setup.
- All-in-one setup framing: begins a transaction and ends with `COMMIT`.
- Archive integrity: the project ZIP passed `unzip -t` before this validation pass; the new archive is rechecked when packaged.

## Issues found and corrected

1. The SQL `create_booking` path previously allowed some malformed intervals to flow past allocation failure and reach table constraints. It now validates required date/time/name/attendee/resource fields inside the RPC before insert.
2. The SQL idempotency lookup now occurs before time-sensitive validation so a valid cached retry can return its original result even after the event date has passed.
3. When an expired SQL idempotency key is reused, the conflict update now refreshes `request_hash` as well as the cached response, booking id, and expiry.

The migration and all-in-one setup were updated together to prevent drift.

## Not yet verified

A PostgreSQL server/client, Docker, and installed project dependencies were not available in this execution environment. Outbound DNS resolution to the package registry also failed, so PostgreSQL and npm dependencies could not be installed here.

Therefore the following have **not** been run on this updated version:

- Applying migrations to a real PostgreSQL/Supabase database.
- PostgreSQL parser/runtime validation of the SQL functions and RLS policies.
- Backend Jest unit/integration/concurrency suites (the attempted `npm test -- --runInBand` command fails because `backend/node_modules/jest` is absent).
- Frontend Vite production build (the attempted `npm run build` command fails because `vite` is not installed in `frontend/node_modules`).
- Supabase Auth and Google OAuth end-to-end flow.
- SQL RPC transactional/concurrency tests under multiple users.

The older baseline measurements in `PROGRESS.md` describe the prior implementation and are not evidence that the new Supabase migrations or UI were integration-tested. Do not switch `BOOKING_ENGINE=sql_rpc` or deploy publicly until the missing checks pass in a real PostgreSQL/Supabase environment.
