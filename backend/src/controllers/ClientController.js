import { query } from '../database/config.js';
import { clientSchema } from '../services/validation/schemas.js';

class ClientController {
  /**
   * Get all clients
   */
  async getAllClients(req, res, next) {
    try {
      const result = await query(`
        SELECT * FROM clients
        WHERE is_active = true
        ORDER BY name ASC
      `);

      res.json({
        success: true,
        count: result.rows.length,
        clients: result.rows
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Get client by ID
   */
  async getClientById(req, res, next) {
    try {
      const clientId = parseInt(req.params.id);

      if (isNaN(clientId)) {
        return res.status(400).json({
          success: false,
          message: 'Invalid client ID'
        });
      }

      const result = await query(
        'SELECT * FROM clients WHERE id = $1',
        [clientId]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({
          success: false,
          message: 'Client not found'
        });
      }

      res.json({
        success: true,
        client: result.rows[0]
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Create a new client
   */
  async createClient(req, res, next) {
    try {
      const validated = clientSchema.parse(req.body);

      const result = await query(
        `INSERT INTO clients (name, email, phone, organization)
         VALUES ($1, $2, $3, $4)
         RETURNING *`,
        [validated.name, validated.email, validated.phone, validated.organization]
      );

      res.status(201).json({
        success: true,
        client: result.rows[0],
        message: 'Client created successfully'
      });
    } catch (error) {
      if (error.name === 'ZodError') {
        return res.status(400).json({
          success: false,
          message: 'Validation failed',
          errors: error.errors
        });
      }
      next(error);
    }
  }

  /**
   * Get client's bookings
   */
  async getClientBookings(req, res, next) {
    try {
      const clientId = parseInt(req.params.id);

      if (isNaN(clientId)) {
        return res.status(400).json({
          success: false,
          message: 'Invalid client ID'
        });
      }

      const result = await query(`
        SELECT b.*, h.name as hall_name, v.name as venue_name
        FROM bookings b
        LEFT JOIN halls h ON b.hall_id = h.id
        JOIN venues v ON b.venue_id = v.id
        WHERE b.client_id = $1
        ORDER BY b.event_date DESC, b.event_start DESC
      `, [clientId]);

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

export default new ClientController();
