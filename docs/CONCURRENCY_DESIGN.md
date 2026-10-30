# Concurrency and consistency design

## Risk addressed

Two requests can both observe “available” at the same time. An application-only check followed by independent inserts is not safe: both requests might pass before either insert becomes visible.

## Controls in this implementation

1. **One transaction for a booking decision:** availability check, booking row, resource allocation rows, audit event, and idempotency result are committed or rolled back together.
2. **Allocation advisory locks:** the service acquires transaction-scoped PostgreSQL advisory locks for each affected event date and venue in stable order. Because allocation can fall back across venues and shared resources are venue-wide, all venues for a date are locked before an availability decision is made.
3. **Booking-level advisory locks:** cancellation/rescheduling mutations to the same booking are serialised before acquiring date/resource locks, avoiding stale-date races between concurrent cancel and reschedule attempts.
4. **Exclusion constraint:** PostgreSQL independently rejects any overlapping confirmed reservations for the same hall/date.
5. **Idempotency:** a unique key and transaction-scoped key lock ensure retries return the previously saved response for the same payload and reject the same key with a different payload.
6. **Retry handling:** transactions can be retried a bounded number of times for PostgreSQL deadlock, serialization, or lock-not-available failures. HTTP handling returns controlled errors if retries are exhausted.
7. **Reschedule atomicity:** a failed allocation logs the failure but leaves the old booking and resource allocations unchanged.

## Shared-resource capacity

There is no simple row-level exclusion constraint for a sum such as “at most two projectors over any overlapping time interval.” The application therefore serialises same-date allocation decisions, re-reads committed bookings inside the transaction, and checks the running usage of all overlapping reservations before allocation. This is conservative and prioritises correctness.

## Trade-off and next optimisation

The current lock scope serialises allocation decisions across venues for the same date, even where two requests might be independent. This intentionally reduces concurrency in exchange for simple correctness. The supplied stress scripts should be run against the actual database and deployment. If measured throughput is insufficient, the next iteration can use narrower locking with a carefully designed venue-fallback protocol and dedicated resource-capacity invariant tests. Do not remove locks simply to improve a benchmark number.

## What the tests should prove

- The same hall never has overlapping confirmed reservation intervals.
- Resource utilization segments never exceed their venue capacity.
- A repeated idempotency key does not duplicate a booking.
- Cancellation releases availability in the same transaction.
- Failed rescheduling preserves original fields and allocations.
- Waitlist promotion follows FIFO order among currently eligible requests.

A 100-request test is a validation activity; it is not proof of unlimited scalability. Report database/server configuration and observed numbers with every benchmark.
