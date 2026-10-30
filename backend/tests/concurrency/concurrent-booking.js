import { randomUUID } from 'node:crypto';
import dotenv from 'dotenv';
import path from 'node:path';

dotenv.config({ path: path.resolve(process.cwd(), '.env') });
if (!process.env.TEST_DATABASE_URL) {
  throw new Error('Set TEST_DATABASE_URL to a dedicated disposable PostgreSQL database before running concurrency tests.');
}
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
const { default: schedulingService } = await import('../../src/services/schedulingService.js');
const { query, closePool } = await import('../../src/database/config.js');

const runId = randomUUID();
const marker = `Concurrency Regression ${runId}`;
const datePlus = days => {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
};
const date1 = process.env.CONCURRENCY_TEST_DATE || datePlus(45);
const date2Date = new Date(`${date1}T00:00:00.000Z`);
date2Date.setUTCDate(date2Date.getUTCDate() + 1);
const date2 = date2Date.toISOString().slice(0, 10);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function getOrCreateClient() {
  const existing = await query('SELECT id FROM clients WHERE email = $1 ORDER BY id LIMIT 1', ['concurrency-test@eventsync.invalid']);
  if (existing.rows.length) return existing.rows[0].id;
  const created = await query(
    'INSERT INTO clients(name, email, organization) VALUES ($1, $2, $3) RETURNING id',
    ['Concurrency Regression Client', 'concurrency-test@eventsync.invalid', 'Automated Test']
  );
  return created.rows[0].id;
}

async function cleanup() {
  // This marker is unique per run, so cleanup never targets user bookings.
  await query('DELETE FROM bookings WHERE event_name LIKE $1', [`${marker}%`]);
}

async function testDate(clientId, eventDate, suffix, attendees = 50) {
  const requests = Array.from({ length: 100 }, (_, index) => ({
    client_id: Number(clientId),
    event_name: `${marker} ${suffix} #${index + 1}`,
    event_date: eventDate,
    event_start: '10:00',
    event_end: '12:00',
    attendees,
    preferred_venue_id: 1,
    projectors_requested: 1,
    audio_systems_requested: 1,
    staff_requested: 2,
  }));
  const startedAt = Date.now();
  const results = await Promise.allSettled(requests.map((request) => schedulingService.confirmBooking(request, randomUUID())));
  const durationMs = Date.now() - startedAt;
  const fulfilled = results.filter(result => result.status === 'fulfilled');
  const errors = results.filter(result => result.status === 'rejected');
  const confirmedResponses = fulfilled.filter(result => result.value?.success === true).length;
  const rejectedResponses = fulfilled.filter(result => result.value?.success === false).length;
  const saved = await query(
    `SELECT id, hall_id, venue_id, event_date, reserved_start, reserved_end, status, event_name
     FROM bookings WHERE event_name LIKE $1 ORDER BY id`,
    [`${marker} ${suffix}%`]
  );
  return { eventDate, durationMs, fulfilled: fulfilled.length, errors: errors.length, confirmedResponses, rejectedResponses, saved: saved.rows };
}

async function main() {
  const clientId = await getOrCreateClient();
  await cleanup();

  console.log(`Running 100-request concurrency checks; test run ${runId}`);
  console.log(`Date 1: ${date1}; Date 2: ${date2}`);
  const sameSlot = await testDate(clientId, date1, 'Same Slot');
  const resourceSlot = await testDate(clientId, date2, 'Shared Resource', 50);

  const hallConflicts = await query(`
    SELECT COUNT(*)::int AS count
    FROM bookings a JOIN bookings b
      ON a.id < b.id AND a.hall_id = b.hall_id AND a.event_date = b.event_date
     AND a.status = 'confirmed' AND b.status = 'confirmed'
     AND tsrange((a.event_date + a.reserved_start)::timestamp, (a.event_date + a.reserved_end)::timestamp)
         && tsrange((b.event_date + b.reserved_start)::timestamp, (b.event_date + b.reserved_end)::timestamp)
    WHERE a.event_date IN ($1::date, $2::date)
  `, [date1, date2]);
  const resourceOverages = await query(`
    SELECT COUNT(*)::int AS count FROM resource_utilization
    WHERE event_date IN ($1::date, $2::date) AND available_quantity < 0
  `, [date1, date2]);
  const runErrors = sameSlot.errors + resourceSlot.errors;
  const totalConfirmed = sameSlot.confirmedResponses + resourceSlot.confirmedResponses;
  const sameHallConflicts = hallConflicts.rows[0].count;
  const overages = resourceOverages.rows[0].count;

  console.log('\nResults');
  for (const [label, result] of [['Same slot', sameSlot], ['Shared-resource contention', resourceSlot]]) {
    console.log(`${label}: 100 requests, ${result.confirmedResponses} confirmed, ${result.rejectedResponses} controlled rejections, ${result.errors} errors, ${result.durationMs} ms`);
  }
  console.log(`Hall overlap conflicts across tested dates: ${sameHallConflicts}`);
  console.log(`Resource-overcapacity segments across tested dates: ${overages}`);

  const passed = runErrors === 0 && totalConfirmed > 0 && sameHallConflicts === 0 && overages === 0;
  console.log(passed ? '\nPASS: no booking/resource invariants were violated.' : '\nFAIL: one or more concurrency checks failed.');
  console.log('Cleaning up test bookings...');
  await cleanup();
  if (!passed) process.exitCode = 1;
}

main().catch(async error => {
  console.error('Concurrency test failed:', error);
  // Also clean up marker-scoped rows when an assertion or query fails midway.
  try { await cleanup(); }
  catch (cleanupError) { console.error('Test-data cleanup failed:', cleanupError.message); }
  process.exitCode = 1;
}).finally(async () => {
  await closePool();
});
