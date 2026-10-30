import dotenv from 'dotenv';
import path from 'node:path';

dotenv.config({ path: path.resolve(process.cwd(), '.env') });
const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) {
  test.skip('PostgreSQL integration checks require TEST_DATABASE_URL in backend/.env', () => {});
} else {
  process.env.DATABASE_URL = databaseUrl;
  const { query, closePool } = await import('../../src/database/config.js');
  afterAll(async () => { await closePool(); });

  test('the migrated and seeded database contains the exact EventSync resource dataset', async () => {
    const venues = await query(`
      SELECT v.name, h.name AS hall_name, h.capacity,
             MAX(vrc.capacity) FILTER (WHERE rt.name = 'projector') AS projectors,
             MAX(vrc.capacity) FILTER (WHERE rt.name = 'audio_system') AS audio_systems,
             MAX(vrc.capacity) FILTER (WHERE rt.name = 'support_staff') AS staff
      FROM venues v
      JOIN halls h ON h.venue_id = v.id
      JOIN venue_resource_capacity vrc ON vrc.venue_id = v.id
      JOIN resource_types rt ON rt.id = vrc.resource_type_id
      GROUP BY v.id, v.name, h.id, h.name, h.capacity
      ORDER BY v.id, h.id
    `);
    expect(venues.rows).toHaveLength(6);
    const hallMap = Object.fromEntries(venues.rows.map(row => [row.hall_name, Number(row.capacity)]));
    expect(hallMap).toEqual({ A1: 60, A2: 150, B1: 100, B2: 200, C1: 80, C2: 250 });

    const constraint = await query(`SELECT COUNT(*)::int AS count FROM pg_constraint WHERE conname = 'no_overlapping_hall_bookings'`);
    expect(constraint.rows[0].count).toBe(1);
    const view = await query(`SELECT to_regclass('public.resource_utilization') AS name`);
    expect(view.rows[0].name).toBe('resource_utilization');
  });
}
