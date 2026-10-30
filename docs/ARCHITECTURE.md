# Architecture

## Active stack

- **Frontend:** React 18 and Vite. The UI calls the Express API through `/api`.
- **API:** Node.js and Express, mounted under `/api/v1` and mirrored under `/api` for frontend compatibility.
- **Persistence:** PostgreSQL via `pg`. SQL migrations and a non-destructive seed script are included.
- **Validation:** Zod request schemas.
- **Tests:** Jest unit/integration tests plus standalone concurrency and HTTP load scripts.

The former SQLite route/configuration fragments from the Node prototype were removed so there is one active persistence path. The Python prototype is retained only under `docs/reference/` for design traceability, not as a second running server.

## Request flow

```text
React screen
  -> API client (Axios)
  -> Express middleware (security headers, rate limit, request/correlation ID)
  -> versioned route
  -> controller (HTTP parsing and status codes)
  -> scheduling service (validation and business rules)
  -> repository (parameterised SQL)
  -> PostgreSQL transaction / constraints
```

### Booking creation

1. Validate the request shape and date/time fields.
2. Begin a transaction and serialise identical idempotency keys if provided.
3. Verify the client and preferred venue exist.
4. Calculate the reserved interval by subtracting/adding 30 minutes.
5. Record an out-of-hours request as rejected when its same-day time representation is valid; otherwise return a controlled validation result.
6. Lock the allocation scope for the event date across venues.
7. Try the preferred venue first. At each venue, inspect suitable halls in ascending capacity order, then check hall conflicts and shared-resource capacity.
8. Insert a confirmed booking and allocations, or persist a rejected/waitlisted decision.
9. Store the audit/idempotency result in the same transaction and commit.

### Cancellation and rescheduling

Cancellation and rescheduling first take a transaction-scoped lock for the booking ID, then take the relevant date/resource allocation locks. This serialises competing mutations to the same booking and uses a consistent lock order. Cancellation updates the status so its hall/resources stop counting as active; allocations remain as history but are ignored by active capacity checks. The waitlist is then reconsidered within the transaction.

Rescheduling revalidates the new request and excludes the existing booking from conflict checks. If no feasible allocation exists, only a failed-reschedule audit event is written; the original booking and allocations remain unchanged. If it succeeds, the booking fields and allocations are replaced atomically.

## Features ported from the Python prototype

- Operations board and timeline presentation.
- FIFO waitlist with automatic promotion after capacity is released.
- Recurring series with all-or-nothing default behaviour.
- Read-only alternative-slot recommendations.
- Decision/audit log screen.
- Sweep-line approach for shared-resource capacity checks.

The frontend is intentionally not allowed to decide if a booking is confirmed. A UI availability preview may become stale; only the transactional backend can confirm.
