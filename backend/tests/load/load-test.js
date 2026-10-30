import { randomUUID } from 'node:crypto';
import dotenv from 'dotenv';
import path from 'node:path';

dotenv.config({ path: path.resolve(process.cwd(), '.env') });
if (!process.env.TEST_DATABASE_URL) {
  throw new Error('Set TEST_DATABASE_URL to a dedicated disposable PostgreSQL database before running load tests.');
}
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
const { query, closePool } = await import('../../src/database/config.js');

const baseUrl = (process.env.TARGET_URL || 'http://localhost:3000/api/v1/bookings').replace(/\/$/, '');
const concurrency = Number.parseInt(process.env.CONCURRENCY || '100', 10);
const runId = randomUUID();
const marker = `EventSync Load ${runId}`;

const datePlus = days => {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
};
const eventDate = process.env.EVENT_DATE || datePlus(30 + Math.floor(Math.random() * 180));
const eventStart = process.env.EVENT_START || '10:00';
const eventEnd = process.env.EVENT_END || '12:00';

const percentile = (sortedValues, p) => {
  if (!sortedValues.length) return 0;
  return sortedValues[Math.min(sortedValues.length - 1, Math.ceil(p * sortedValues.length) - 1)];
};

async function main() {
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 1000) {
    throw new Error('CONCURRENCY must be an integer between 1 and 1000.');
  }
  const clientId = process.env.CLIENT_ID
    ? Number.parseInt(process.env.CLIENT_ID, 10)
    : Number((await query('SELECT id FROM clients WHERE is_active = true ORDER BY id LIMIT 1')).rows[0]?.id);
  const preferredVenueId = process.env.VENUE_ID
    ? Number.parseInt(process.env.VENUE_ID, 10)
    : Number((await query('SELECT id FROM venues ORDER BY id LIMIT 1')).rows[0]?.id);

  if (!Number.isInteger(clientId) || clientId < 1) throw new Error('No active client found. Run `npm run seed` or set CLIENT_ID.');
  if (!Number.isInteger(preferredVenueId) || preferredVenueId < 1) throw new Error('No venue found. Run `npm run seed` or set VENUE_ID.');

  console.log(`Target: ${baseUrl}`);
  console.log(`Concurrent requests: ${concurrency}`);
  console.log(`Shared slot: ${eventDate} ${eventStart}-${eventEnd}; preferred venue ID ${preferredVenueId}`);
  console.log('This test writes test bookings to the configured database. Use a staging/test database, not production.');

  const requests = Array.from({ length: concurrency }, (_, index) => ({
    client_id: clientId,
    event_name: `${marker} #${index + 1}`,
    event_date: eventDate,
    event_start: eventStart,
    event_end: eventEnd,
    attendees: Number.parseInt(process.env.ATTENDEES || '50', 10),
    preferred_venue_id: preferredVenueId,
    projectors_requested: Number.parseInt(process.env.PROJECTORS || '1', 10),
    audio_systems_requested: Number.parseInt(process.env.AUDIO_SYSTEMS || '1', 10),
    staff_requested: Number.parseInt(process.env.STAFF || '2', 10),
  }));

  const latencies = [];
  const statusCounts = new Map();
  const errors = [];
  const startedAt = Date.now();
  const responses = await Promise.all(requests.map(async (body, index) => {
    const requestStarted = Date.now();
    try {
      const response = await fetch(baseUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': randomUUID(),
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(Number.parseInt(process.env.REQUEST_TIMEOUT_MS || '60000', 10)),
      });
      const latency = Date.now() - requestStarted;
      latencies.push(latency);
      statusCounts.set(response.status, (statusCounts.get(response.status) || 0) + 1);
      let payload = null;
      try { payload = await response.json(); } catch { /* keep malformed responses visible below */ }
      if (response.status >= 500 || !payload) {
        errors.push({ index: index + 1, status: response.status, message: payload?.message || 'Missing/invalid JSON response' });
      }
      return { status: response.status, latency, payload };
    } catch (error) {
      errors.push({ index: index + 1, status: null, message: error.message });
      return { status: null, latency: Date.now() - requestStarted, error: error.message };
    }
  }));
  const elapsedMs = Date.now() - startedAt;
  const sorted = [...latencies].sort((a, b) => a - b);
  const succeeded = responses.filter(r => r.payload?.success === true).length;
  const waitlisted = responses.filter(r => r.payload?.waitlisted === true).length;
  const businessRejections = responses.filter(r => r.payload?.success === false && !r.payload?.waitlisted).length;

  const invariants = await query(`
    SELECT COUNT(*)::int AS count
    FROM bookings a JOIN bookings b
      ON a.id < b.id AND a.hall_id = b.hall_id AND a.event_date = b.event_date
     AND a.status = 'confirmed' AND b.status = 'confirmed'
     AND tsrange((a.event_date + a.reserved_start)::timestamp, (a.event_date + a.reserved_end)::timestamp)
         && tsrange((b.event_date + b.reserved_start)::timestamp, (b.event_date + b.reserved_end)::timestamp)
    WHERE a.event_date = $1::date AND b.event_date = $1::date
  `, [eventDate]);
  const resourceIssues = await query(`
    SELECT COUNT(*)::int AS count FROM resource_utilization
    WHERE event_date = $1::date AND available_quantity < 0
  `, [eventDate]);
  const savedRunCount = await query('SELECT COUNT(*)::int AS count FROM bookings WHERE event_name LIKE $1', [`${marker}%`]);

  console.log('\n=== Load test results ===');
  console.log(`Total requests:             ${concurrency}`);
  console.log(`Requests/sec:                ${(concurrency / Math.max(elapsedMs / 1000, 0.001)).toFixed(2)}`);
  console.log(`Elapsed time:                ${elapsedMs} ms`);
  console.log(`HTTP response latencies:     p50 ${percentile(sorted, 0.50)} ms | p95 ${percentile(sorted, 0.95)} ms | p99 ${percentile(sorted, 0.99)} ms`);
  console.log(`Confirmed:                   ${succeeded}`);
  console.log(`Waitlisted:                  ${waitlisted}`);
  console.log(`Controlled business rejects: ${businessRejections}`);
  console.log(`HTTP status counts:          ${JSON.stringify(Object.fromEntries([...statusCounts.entries()].sort((a, b) => a[0] - b[0])))}`);
  console.log(`Unexpected errors:           ${errors.length}`);
  console.log(`Confirmed hall overlaps:     ${invariants.rows[0].count}`);
  console.log(`Resource overcapacity rows:  ${resourceIssues.rows[0].count}`);
  console.log(`Saved bookings for this run: ${savedRunCount.rows[0].count}`);
  console.log(`Run marker:                  ${marker}`);

  if (errors.length) console.log('First errors:', JSON.stringify(errors.slice(0, 10), null, 2));

  if (process.env.CLEANUP_LOAD_TEST === 'true') {
    // Test-only, run-marker-scoped cleanup; never targets unrelated bookings.
    await query('DELETE FROM bookings WHERE event_name LIKE $1', [`${marker}%`]);
    console.log('Cleaned up bookings created by this run. Audit rows are retained by design.');
  } else {
    console.log(`Optional cleanup: DELETE FROM bookings WHERE event_name LIKE '${marker.replaceAll("'", "''")}%';`);
  }

  const passed = errors.length === 0 && invariants.rows[0].count === 0 && resourceIssues.rows[0].count === 0 && succeeded > 0;
  console.log(passed ? '\nPASS: load test completed without HTTP errors or detected allocation invariant violations.' : '\nFAIL: inspect errors, conflicts, and resource-overcapacity results above.');
  if (!passed) process.exitCode = 1;
}

main().catch(error => {
  console.error('Load test failed:', error.message);
  process.exitCode = 1;
}).finally(async () => {
  await closePool();
});
