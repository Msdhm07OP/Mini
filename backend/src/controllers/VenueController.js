import { query } from '../database/config.js';

class VenueController {
  /**
   * Get all venues with halls and resources
   */
  async getAllVenues(req, res, next) {
    try {
      const venuesResult = await query(`
        SELECT
          v.id,
          v.name,
          v.created_at,
          v.updated_at,
          json_agg(
            DISTINCT jsonb_build_object(
              'id', h.id,
              'name', h.name,
              'capacity', h.capacity,
              'is_active', h.is_active
            ) ORDER BY jsonb_build_object('id', h.id, 'name', h.name, 'capacity', h.capacity, 'is_active', h.is_active)
          ) FILTER (WHERE h.id IS NOT NULL) as halls,
          json_agg(
            DISTINCT jsonb_build_object(
              'resource_type', rt.name,
              'capacity', vrc.capacity
            ) ORDER BY jsonb_build_object('resource_type', rt.name, 'capacity', vrc.capacity)
          ) FILTER (WHERE rt.id IS NOT NULL) as resources
        FROM venues v
        LEFT JOIN halls h ON v.id = h.venue_id
        LEFT JOIN venue_resource_capacity vrc ON v.id = vrc.venue_id
        LEFT JOIN resource_types rt ON vrc.resource_type_id = rt.id
        GROUP BY v.id
        ORDER BY v.id
      `);

      res.json({
        success: true,
        count: venuesResult.rows.length,
        venues: venuesResult.rows
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Get venue by ID
   */
  async getVenueById(req, res, next) {
    try {
      const venueId = parseInt(req.params.id);

      if (isNaN(venueId)) {
        return res.status(400).json({
          success: false,
          message: 'Invalid venue ID'
        });
      }

      const result = await query(`
        SELECT
          v.id,
          v.name,
          v.created_at,
          v.updated_at,
          json_agg(
            DISTINCT jsonb_build_object(
              'id', h.id,
              'name', h.name,
              'capacity', h.capacity,
              'is_active', h.is_active
            ) ORDER BY jsonb_build_object('id', h.id, 'name', h.name, 'capacity', h.capacity, 'is_active', h.is_active)
          ) FILTER (WHERE h.id IS NOT NULL) as halls,
          json_agg(
            DISTINCT jsonb_build_object(
              'resource_type', rt.name,
              'capacity', vrc.capacity
            ) ORDER BY jsonb_build_object('resource_type', rt.name, 'capacity', vrc.capacity)
          ) FILTER (WHERE rt.id IS NOT NULL) as resources
        FROM venues v
        LEFT JOIN halls h ON v.id = h.venue_id
        LEFT JOIN venue_resource_capacity vrc ON v.id = vrc.venue_id
        LEFT JOIN resource_types rt ON vrc.resource_type_id = rt.id
        WHERE v.id = $1
        GROUP BY v.id
      `, [venueId]);

      if (result.rows.length === 0) {
        return res.status(404).json({
          success: false,
          message: 'Venue not found'
        });
      }

      res.json({
        success: true,
        venue: result.rows[0]
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Get bookings for a venue
   */
  async getVenueBookings(req, res, next) {
    try {
      const venueId = parseInt(req.params.id);

      if (isNaN(venueId)) {
        return res.status(400).json({
          success: false,
          message: 'Invalid venue ID'
        });
      }

      const { date, status } = req.query;
      let sql = `
        SELECT b.*, h.name as hall_name, c.name as client_name
        FROM bookings b
        LEFT JOIN halls h ON b.hall_id = h.id
        JOIN clients c ON b.client_id = c.id
        WHERE b.venue_id = $1
      `;

      const params = [venueId];
      let paramCount = 2;

      if (date) {
        sql += ` AND b.event_date = $${paramCount}`;
        params.push(date);
        paramCount++;
      }

      if (status) {
        sql += ` AND b.status = $${paramCount}`;
        params.push(status);
        paramCount++;
      }

      sql += ' ORDER BY b.event_date ASC, b.event_start ASC';

      const result = await query(sql, params);

      res.json({
        success: true,
        count: result.rows.length,
        bookings: result.rows
      });
    } catch (error) {
      next(error);
    }
  }
}

export default new VenueController();
