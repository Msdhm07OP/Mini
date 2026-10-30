/**
 * Demo data for presentations.
 *
 * Every booking goes through the same create_booking / cancel_booking RPCs the
 * app uses, so allocations, status history, event orders, waitlist entries and
 * rejections are produced by the real scheduling rules. Idempotency keys make
 * reruns safe: an already-submitted request returns its original result.
 *
 * Usage: node src/database/seed-demo.js [admin-email]
 */
import pool from './config.js';

const actorEmail = process.argv[2] || 'test@gmail.com';

const day = offset => {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
};

// [key, client, venue, event, dayOffset, start, end, attendees, projectors, audio, staff, waitlist]
const requests = [
  ['d01', 'Innovation Labs', 'Venue A', 'AI Product Launch', 3, '10:00', '12:00', 120, 2, 1, 2, false],
  ['d02', 'Creative Studio', 'Venue A', 'Design Sprint Workshop', 3, '13:00', '15:00', 45, 1, 0, 1, false],
  ['d03', 'TechCorp Solutions', 'Venue B', 'Quarterly All-Hands', 3, '09:00', '11:00', 180, 1, 1, 2, false],
  ['d04', 'Global Ventures', 'Venue C', 'Investor Pitch Day', 3, '14:00', '18:00', 220, 2, 2, 4, false],
  ['d05', 'Marketing Masters', 'Venue B', 'Brand Strategy Offsite', 4, '10:00', '13:00', 90, 1, 0, 1, false],
  ['d06', 'Innovation Labs', 'Venue C', 'Hackathon Kickoff', 4, '09:00', '12:00', 240, 3, 2, 5, false],
  ['d07', 'Creative Studio', 'Venue A', 'Portfolio Review', 4, '15:00', '17:00', 55, 1, 1, 1, false],
  ['d08', 'TechCorp Solutions', 'Venue A', 'Security Training', 5, '09:00', '11:00', 60, 1, 0, 1, false],
  ['d09', 'Global Ventures', 'Venue B', 'Partner Summit', 5, '13:00', '17:00', 190, 2, 1, 3, false],
  ['d10', 'Marketing Masters', 'Venue C', 'Product Photo Shoot', 6, '10:00', '14:00', 30, 0, 1, 2, false],
  // Contention: Venue B has a single audio system, so overlapping audio requests compete.
  ['d11', 'Innovation Labs', 'Venue B', 'Tech Talk Series', 7, '10:00', '12:00', 80, 1, 1, 1, false],
  ['d12', 'Creative Studio', 'Venue B', 'Live Podcast Recording', 7, '10:30', '12:30', 70, 0, 1, 1, true],
  ['d13', 'Marketing Masters', 'Venue B', 'Campaign Showcase', 7, '11:00', '12:00', 60, 1, 1, 1, false],
  // Exhausts Venue C, then a second large waitlist request queues behind it.
  ['d14', 'Global Ventures', 'Venue C', 'Annual Gala Rehearsal', 8, '14:00', '20:00', 250, 3, 2, 6, false],
  ['d15', 'TechCorp Solutions', 'Venue C', 'Developer Conference', 8, '15:00', '18:00', 245, 3, 2, 6, true],
  // No hall can seat this many guests.
  ['d16', 'Innovation Labs', 'Venue C', 'City-wide Expo', 9, '10:00', '16:00', 400, 2, 2, 4, false],
  ['d17', 'Creative Studio', 'Venue A', 'Client Feedback Session', 10, '11:00', '12:30', 25, 1, 0, 0, false],
  ['d18', 'Marketing Masters', 'Venue B', 'Influencer Meetup', 10, '16:00', '19:00', 140, 1, 1, 2, false],
  ['d19', 'Global Ventures', 'Venue A', 'Board Meeting', 11, '09:00', '10:30', 20, 1, 0, 0, false],
  ['d20', 'TechCorp Solutions', 'Venue C', 'Cloud Migration Workshop', 12, '13:00', '17:00', 75, 2, 1, 2, false],
];

// Cancelled after creation to demonstrate cancellation and resource release.
const cancellations = { d08: 'Client rescheduled to next quarter' };

async function asActor(client, userId, sql, params) {
  await client.query('BEGIN');
  try {
    await client.query(
      "SELECT set_config('request.jwt.claim.sub', $1, true), set_config('request.jwt.claims', $2, true)",
      [userId, JSON.stringify({ sub: userId, role: 'authenticated', aud: 'authenticated' })],
    );
    const result = await client.query(sql, params);
    await client.query('COMMIT');
    return result.rows[0]?.res;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

async function main() {
  const client = await pool.connect();
  try {
    const actor = await client.query(
      `SELECT u.id, p.role FROM auth.users u JOIN public.user_profiles p ON p.user_id = u.id WHERE lower(u.email) = lower($1)`,
      [actorEmail],
    );
    if (!actor.rows.length || !['admin', 'manager', 'staff'].includes(actor.rows[0].role)) {
      throw new Error(`${actorEmail} must exist and have an admin, manager, or staff role.`);
    }
    const userId = actor.rows[0].id;

    const ids = async (table, names) => {
      const rows = (await client.query(`SELECT id, name FROM public.${table} WHERE name = ANY($1)`, [names])).rows;
      return Object.fromEntries(rows.map(row => [row.name, row.id]));
    };
    const clients = await ids('clients', [...new Set(requests.map(r => r[1]))]);
    const venues = await ids('venues', [...new Set(requests.map(r => r[2]))]);

    const outcomes = {};
    for (const [key, clientName, venueName, eventName, offset, start, end, attendees, projectors, audio, staff, waitlist] of requests) {
      const request = {
        client_id: clients[clientName], preferred_venue_id: venues[venueName], event_name: eventName,
        event_date: day(offset), event_start: start, event_end: end, attendees,
        projectors_requested: projectors, audio_systems_requested: audio, staff_requested: staff,
        waitlist_if_full: waitlist,
      };
      try {
        const res = await asActor(client, userId, 'SELECT public.create_booking($1::jsonb, $2::text) AS res', [JSON.stringify(request), `demo-seed-${key}`]);
        const booking = res?.booking || {};
        outcomes[booking.status] = (outcomes[booking.status] || 0) + 1;
        console.log(`${key} ${String(booking.status).padEnd(10)} ${eventName}`);
        if (cancellations[key] && booking.status === 'confirmed') {
          await asActor(client, userId, 'SELECT public.cancel_booking($1::integer, $2::text) AS res', [booking.id, cancellations[key]]);
          outcomes.confirmed -= 1;
          outcomes.cancelled = (outcomes.cancelled || 0) + 1;
          console.log(`${key} cancelled  ${eventName}`);
        }
      } catch (error) {
        console.log(`${key} error      ${eventName}: ${error.message}`);
      }
    }
    console.log('\nSummary:', outcomes);
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(error => {
  console.error(error.message);
  process.exit(1);
});
