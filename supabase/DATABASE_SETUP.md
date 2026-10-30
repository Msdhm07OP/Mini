# EventSync — Supabase Database Setup

This folder contains the database schema, security policies, SQL booking functions, seed data, and setup helpers for a fresh Supabase project.

## Can the hosted project be created automatically?

The files can be prepared here, but creating a live hosted Supabase project requires signing into your Supabase account. No live database has been provisioned by this package. Do not send database passwords or service-role keys in chat.

## Option A — easiest: Supabase SQL Editor

1. Create a **new** Supabase project in your Supabase account.
2. Open **SQL Editor** in the dashboard.
3. Open `SUPABASE_SETUP_ALL_IN_ONE.sql`, copy all of its contents, paste it into a new SQL query, and run it once. It installs the core schema, analytics views, event orders, auth/RLS policies, booking RPC functions, and idempotent reference seed data.
4. Confirm there are no SQL errors. Check **Table Editor** for `venues`, `halls`, `clients`, `bookings`, `user_profiles`, `event_orders`, and `booking_resource_allocations`.
5. In **Authentication → Users**, create or sign up your own account.
6. Edit the placeholder email in `BOOTSTRAP_FIRST_ADMIN.sql` to your own account email and run that script in SQL Editor to make your account an administrator. Do this only for an account you control.
7. Configure Auth → URL Configuration. For local frontend development, allow `http://localhost:5173` as the site/redirect URL. Configure Google OAuth credentials separately in **Authentication → Providers → Google** if Google sign-in is required.
8. Set the environment variables from `backend/.env.example` and `frontend/.env.example`. Keep database credentials and any service-role key strictly on the backend; only the Supabase project URL and publishable/anon key belong in the frontend.

**Important:** `SUPABASE_SETUP_ALL_IN_ONE.sql` is for a brand-new project only. Do not run it against an existing EventSync database because it includes initial table/type creation. If you prefer migration tracking, use Option B instead.

## Option B — versioned migrations (recommended for ongoing development)

Install the Supabase CLI, authenticate, link this project to your Supabase project, review the linked project ref, and run `supabase db push` from the project root. This applies the migration files in order and records them in Supabase's migration history. Confirm the target project before pushing. Seed data can be applied using the Supabase CLI seed workflow or by running `supabase/seed.sql` once. Do not run Option A after migrations have already been applied.

## Demo data

The seed file creates Venue A/B/C, six halls, resource pools, and five demo client records. It is designed to be safe to rerun and does not create fake bookings. The application still needs a mapping from each client-role auth profile to a `clients.id` before that client can use client-scoped booking RPCs. Keep that mapping intentional; do not permit a client to choose another client's ID.

## Security bootstrap and roles

New Supabase users are assigned the `client` role by default. The first administrator must be promoted using `BOOTSTRAP_FIRST_ADMIN.sql` after signing up. For customer accounts, link `user_profiles.client_id` to the correct `clients.id` using an owner-controlled workflow. Do not let public signup metadata choose an `admin`, `manager`, or `staff` role.

## Verification notes

The SQL files are packaged, but this environment has not applied them to your hosted Supabase instance. After setup, verify sign-in, role assignment, RLS behaviour for client vs staff/admin, booking creation/cancellation/rescheduling, recurring series, waitlist promotion, event orders, analytics, and the frontend production build before deployment. Use a separate development project for first application.
