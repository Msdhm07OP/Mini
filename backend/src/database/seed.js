import { transaction, query, closePool } from './config.js';

const VENUES = [
  { name: 'Venue A', halls: [['A1', 60], ['A2', 150]], resources: { projector: 2, audio_system: 2, support_staff: 5 } },
  { name: 'Venue B', halls: [['B1', 100], ['B2', 200]], resources: { projector: 2, audio_system: 1, support_staff: 4 } },
  { name: 'Venue C', halls: [['C1', 80], ['C2', 250]], resources: { projector: 3, audio_system: 2, support_staff: 6 } },
];
const RESOURCE_TYPES = [
  ['projector', 'Digital projectors for presentations', 'units'],
  ['audio_system', 'Audio systems for events', 'units'],
  ['support_staff', 'Support staff members', 'people'],
];
const CLIENTS = [
  ['TechCorp Solutions', 'contact@techcorp.com', '+1-555-0101', 'Technology Company'],
  ['Marketing Masters', 'events@marketingmasters.com', '+1-555-0102', 'Marketing Agency'],
  ['Innovation Labs', 'hello@innovationlabs.io', '+1-555-0103', 'Research Institute'],
  ['Global Ventures', 'info@globalventures.com', '+1-555-0104', 'Investment Firm'],
  ['Creative Studio', 'bookings@creativestudio.net', '+1-555-0105', 'Design Agency'],
];

async function seed() {
  try {
    await transaction(async client => {
      // Seed is intentionally non-destructive and safe to run more than once.
      const resourceIds = {};
      for (const [name, description, unit] of RESOURCE_TYPES) {
        const result = await client.query(`
          INSERT INTO resource_types (name, description, unit)
          VALUES ($1, $2, $3)
          ON CONFLICT (name) DO UPDATE SET description = EXCLUDED.description, unit = EXCLUDED.unit
          RETURNING id
        `, [name, description, unit]);
        resourceIds[name] = result.rows[0].id;
      }

      for (const venueData of VENUES) {
        const venueResult = await client.query(
          'INSERT INTO venues (name) VALUES ($1) ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name RETURNING id',
          [venueData.name]
        );
        const venueId = venueResult.rows[0].id;
        for (const [hallName, capacity] of venueData.halls) {
          await client.query(`
            INSERT INTO halls (venue_id, name, capacity)
            VALUES ($1, $2, $3)
            ON CONFLICT (venue_id, name) DO UPDATE SET capacity = EXCLUDED.capacity, is_active = true
          `, [venueId, hallName, capacity]);
        }
        for (const [resourceName, capacity] of Object.entries(venueData.resources)) {
          await client.query(`
            INSERT INTO venue_resource_capacity (venue_id, resource_type_id, capacity)
            VALUES ($1, $2, $3)
            ON CONFLICT (venue_id, resource_type_id) DO UPDATE SET capacity = EXCLUDED.capacity
          `, [venueId, resourceIds[resourceName], capacity]);
        }
      }

      for (const [name, email, phone, organization] of CLIENTS) {
        await client.query(`
          INSERT INTO clients (name, email, phone, organization)
          SELECT $1::varchar, $2::varchar, $3::varchar, $4::varchar
          WHERE NOT EXISTS (SELECT 1 FROM clients WHERE email = $2::varchar)
        `, [name, email, phone, organization]);
      }
    });

    const summary = await query(`
      -- Halls and resources are aggregated in separate subqueries on purpose.
      -- Joining both to venues in one pass multiplies hall rows by the number
      -- of resource rows, which made every hall appear three times.
      SELECT v.name AS venue, hall_summary.halls,
             res.projectors, res.audio_systems, res.support_staff
      FROM venues v
      LEFT JOIN LATERAL (
        SELECT json_agg(json_build_object('hall', h.name, 'capacity', h.capacity)
                        ORDER BY h.capacity, h.name) AS halls
        FROM halls h WHERE h.venue_id = v.id AND h.is_active
      ) hall_summary ON true
      LEFT JOIN LATERAL (
        SELECT MAX(vrc.capacity) FILTER (WHERE rt.name = 'projector') AS projectors,
               MAX(vrc.capacity) FILTER (WHERE rt.name = 'audio_system') AS audio_systems,
               MAX(vrc.capacity) FILTER (WHERE rt.name = 'support_staff') AS support_staff
        FROM venue_resource_capacity vrc
        JOIN resource_types rt ON rt.id = vrc.resource_type_id
        WHERE vrc.venue_id = v.id
      ) res ON true
      ORDER BY v.id
    `);
    console.log('EventSync reference data is seeded (existing bookings were preserved).');
    summary.rows.forEach(row => {
      console.log(`\n${row.venue}: ${row.halls.map(h => `${h.hall} (${h.capacity})`).join(', ')}`);
      console.log(`Resources: ${row.projectors} projectors, ${row.audio_systems} audio systems, ${row.support_staff} staff`);
    });
  } catch (error) {
    console.error('Seed failed:', error.message);
    process.exitCode = 1;
  } finally {
    await closePool();
  }
}

seed();
