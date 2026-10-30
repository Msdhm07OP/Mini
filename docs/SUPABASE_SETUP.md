# EventSync 3.0 — Supabase setup and security

This guide configures the new Supabase Auth, RLS, and database RPC layer. The existing JavaScript transaction engine remains the default for local PostgreSQL. Use the SQL RPC engine only after the Supabase migrations have been applied and a real Auth user has an EventSync profile.

## 1. Apply the Supabase schema

1. Create a Supabase project and install the Supabase CLI.
2. From the project root, run `supabase login` and `supabase link --project-ref YOUR_PROJECT_REF`.
3. Review `supabase/migrations/` and run `supabase db push` against the intended project.
4. Populate the official Venue A/B/C dataset by running `supabase/seed.sql` in the Supabase SQL Editor, or through `psql` using your project database connection.
5. Confirm migrations `20261030000001` through `20261030000004` completed. The first two migrations establish the existing core/analytics schema, the third adds user profiles and event orders, and the fourth adds Auth, RLS, and the booking RPC functions.

**Important:** these migrations target a fresh Supabase database. If the project already contains an independently managed copy of the EventSync schema, compare its migration history first; do not blindly apply a second copy of the initial schema.

## 2. Configure identity and operational roles

New Supabase Auth users receive a `public.user_profiles` row with the `client` role. This is intentional: new sign-ups must not receive staff permissions automatically.

Create an account through Supabase Auth (email/password or a configured Google provider), then assign the first administrator using the Supabase SQL Editor. Replace the email with your own account:

```sql
UPDATE public.user_profiles AS p
SET role = 'admin', updated_at = NOW()
FROM auth.users AS u
WHERE p.user_id = u.id
  AND lower(u.email) = lower('admin@example.com');
```

Available roles are `admin`, `manager`, `staff`, and `client`. This UI is the operational workspace, so the frontend requires an `admin`, `manager`, or `staff` profile. Admins can configure role/client mappings in SQL. Link a client account to an existing row in `public.clients` when applicable:

```sql
UPDATE public.user_profiles AS p
SET client_id = c.id, updated_at = NOW()
FROM auth.users AS u
JOIN public.clients AS c ON lower(c.email) = lower(u.email)
WHERE p.user_id = u.id
  AND p.role = 'client'
  AND c.email IS NOT NULL;
```

Configure Google under **Authentication → Providers → Google** in the Supabase dashboard, including the Google OAuth client credentials and the Supabase callback URL shown by the dashboard. Add the local and deployed frontend origins under the Auth URL configuration. The frontend uses a PKCE verifier/challenge and exchanges the callback code for a session; verify the complete redirect flow in your own project. If you do not configure Google, email/password sign-in remains available.

## 3. Configure the backend

Copy `backend/.env.example` to `backend/.env`. Keep database credentials only on the backend.

```dotenv
NODE_ENV=development
DATABASE_URL=YOUR_SUPABASE_POSTGRES_CONNECTION_STRING
DB_SSL=true
SUPABASE_URL=https://YOUR_PROJECT_REF.supabase.co
SUPABASE_ANON_KEY=YOUR_SUPABASE_PUBLISHABLE_OR_ANON_KEY
AUTH_MODE=required
BOOKING_ENGINE=javascript
CORS_ORIGIN=http://localhost:5173
```

For local-only work with a local PostgreSQL instance and no Supabase Auth, leave Supabase values blank and keep `AUTH_MODE=auto`; the API announces that it is in **local demo mode**. Do not expose local demo mode publicly. In production, the server refuses to start without Supabase Auth configured.

`BOOKING_ENGINE=javascript` uses the existing tested Node transaction workflow. After applying the Supabase migrations and configuring Auth, `BOOKING_ENGINE=sql_rpc` switches create/cancel/reschedule/recurring-series writes to the `SECURITY DEFINER` PostgreSQL functions. The API validates the Supabase token first and propagates only the verified user id into the PostgreSQL request-claim context. The SQL functions independently check `auth.uid()` and the user's EventSync role.

## 4. Configure the frontend

Copy `frontend/.env.example` to `frontend/.env`:

```dotenv
VITE_API_BASE_URL=/api
VITE_SUPABASE_URL=https://YOUR_PROJECT_REF.supabase.co
VITE_SUPABASE_ANON_KEY=YOUR_SUPABASE_PUBLISHABLE_OR_ANON_KEY
```

Then run the backend and frontend using the existing README instructions. When both frontend Supabase values are set, the app displays the sign-in screen and attaches the access token to API requests. When those values are blank, the existing local demonstration UI remains available, clearly marked as unauthenticated local demo mode.

Only the public/publishable (or legacy anon) key belongs in frontend configuration. **Never put the Supabase `service_role` key or a database password in any `VITE_*` variable.**

## 5. Database RPC functions

The Supabase migration exposes these authenticated RPC entry points:

- `create_booking(p_request, p_idempotency_key)` — preferred venue first, smallest sufficient hall, half-open reserved interval, shared-resource peak checks, and per-user idempotency.
- `cancel_booking(p_booking_id, p_reason)` — transactional cancellation, resource release, audit event, and FIFO waitlist promotion.
- `reschedule_booking(p_booking_id, p_request)` — checks the proposed allocation before updating the existing booking; failure leaves it unchanged.
- `promote_waitlist(p_event_date)` — staff/manager/admin-triggered FIFO promotion.
- `create_recurring_series(p_request, p_occurrences, p_every_days, p_all_or_nothing, p_idempotency_key)` — creates a recurring series inside one database transaction; all-or-nothing mode rolls back earlier occurrences if a later occurrence cannot be allocated.

The RPC functions use the same half-open convention as the existing application: a reservation is `[reserved_start, reserved_end)`, and an end boundary is reusable by a booking beginning at that exact time. Shared-resource checks are evaluated at each relevant booking start boundary and include existing confirmed resource allocations.

## 6. RLS model

- Venues, halls, resource types, and venue capacity are readable by authenticated users; writes are admin-only.
- Staff/manager/admin roles can access operational records; a client role can read only records linked to its `client_id`.
- Direct authenticated table writes to bookings and resource allocations are not allowed. Booking state changes go through the RPCs.
- Idempotency records have no direct authenticated REST access.
- Analytics views are configured with invoker security so they cannot bypass row-level policies on their underlying tables.

The Express backend uses the server-only database connection, which must be treated as privileged. Its Supabase Auth middleware and role checks are therefore mandatory for every API route. RLS is an additional boundary for direct Supabase Data API access, not a substitute for server middleware.

## 7. Important operational notes

- Run local migrations with `cd backend && npm run migrate` for the existing non-Supabase Postgres workflow. Supabase CLI migrations live separately under `supabase/migrations/`.
- No live Supabase project was available when this code was prepared, so the new Supabase SQL migrations and Auth flows still need to be applied and verified against your own project before deployment.
- The new event-order API is exposed at `/api/v1/event-orders` (and the compatibility alias `/api/event-orders`). It is restricted to the operational roles by backend middleware.
