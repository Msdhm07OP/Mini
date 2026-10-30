import schedulingService from '../services/schedulingService.js';
import bookingRepo from '../repositories/BookingRepository.js';
import { bookingRequestSchema, queryFiltersSchema, cancellationSchema } from '../services/validation/schemas.js';
import logger from '../utils/logger/index.js';

class BookingController {
  /**
   * Create a new booking
   */
  async createBooking(req, res, next) {
    try {
      const idempotencyKey = req.headers['idempotency-key'];
      if (idempotencyKey && (typeof idempotencyKey !== 'string' || idempotencyKey.length > 255)) {
        return res.status(400).json({ success: false, message: 'Idempotency-Key must be a string of at most 255 characters' });
      }
      const result = await schedulingService.confirmBooking(req.body, req.correlationId, idempotencyKey, req.user);
      const statusCode = result.success ? 201 : (result.waitlisted ? 202 : 400);
      res.status(statusCode).json(result);
    } catch (error) {
      if (error.name === 'ZodError') {
        return res.status(400).json({
          success: false,
          message: 'Validation failed',
          errors: error.errors.map(e => `${e.path.join('.')}: ${e.message}`)
        });
      }
      next(error);
    }
  }

  /**
   * Get all bookings with filters
   */
  async getBookings(req, res, next) {
    try {
      const filters = queryFiltersSchema.parse({
        status: req.query.status,
        venue_id: req.query.venue_id ? parseInt(req.query.venue_id) : undefined,
        client_id: req.query.client_id ? parseInt(req.query.client_id) : undefined,
        event_date: req.query.event_date,
        date_from: req.query.date_from,
        date_to: req.query.date_to,
        limit: req.query.limit ? parseInt(req.query.limit) : undefined,
        offset: req.query.offset ? parseInt(req.query.offset) : undefined
      });

      const bookings = await bookingRepo.getBookings(filters);

      res.json({
        success: true,
        count: bookings.length,
        bookings
      });
    } catch (error) {
      if (error.name === 'ZodError') {
        return res.status(400).json({
          success: false,
          message: 'Invalid query parameters',
          errors: error.errors
        });
      }
      next(error);
    }
  }

  /**
   * Get booking by ID
   */
  async getBookingById(req, res, next) {
    try {
      const bookingId = parseInt(req.params.id);

      if (isNaN(bookingId)) {
        return res.status(400).json({
          success: false,
          message: 'Invalid booking ID'
        });
      }

      const booking = await bookingRepo.getBookingById(bookingId);

      if (!booking) {
        return res.status(404).json({
          success: false,
          message: 'Booking not found'
        });
      }

      res.json({
        success: true,
        booking
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Cancel a booking
   */
  async cancelBooking(req, res, next) {
    try {
      const bookingId = parseInt(req.params.id);

      if (isNaN(bookingId)) {
        return res.status(400).json({
          success: false,
          message: 'Invalid booking ID'
        });
      }

      const { reason } = cancellationSchema.parse(req.body || {});

      const result = await schedulingService.cancelBooking(
        bookingId,
        reason,
        req.correlationId,
        req.user
      );

      res.json(result);
    } catch (error) {
      if (error.message.includes('not found') || error.message.includes('not in confirmed status')) {
        return res.status(404).json({
          success: false,
          message: error.message
        });
      }
      next(error);
    }
  }

  /**
   * Reschedule a booking
   */
  async rescheduleBooking(req, res, next) {
    try {
      const bookingId = parseInt(req.params.id);

      if (isNaN(bookingId)) {
        return res.status(400).json({
          success: false,
          message: 'Invalid booking ID'
        });
      }

      const result = await schedulingService.rescheduleBooking(
        bookingId,
        req.body,
        req.correlationId,
        req.user
      );

      const statusCode = result.success ? 200 : 400;
      res.status(statusCode).json(result);
    } catch (error) {
      if (error.name === 'ZodError') {
        return res.status(400).json({
          success: false,
          message: 'Validation failed',
          errors: error.errors
        });
      }
      if (error.message.includes('not found') || error.message.includes('not in confirmed status')) {
        return res.status(404).json({
          success: false,
          message: error.message
        });
      }
      next(error);
    }
  }

  /**
   * Get alternative time slots
   */
  async getAlternatives(req, res, next) {
    try {
      bookingRequestSchema.parse(req.body);

      const alternatives = await schedulingService.getAlternativeSlots(req.body);

      res.json({
        success: true,
        count: alternatives.length,
        alternatives
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

  async getWaitlist(req, res, next) {
    try {
      const eventDate = req.query.event_date;
      if (eventDate && !/^\d{4}-\d{2}-\d{2}$/.test(eventDate)) {
        return res.status(400).json({ success: false, message: 'event_date must use YYYY-MM-DD format' });
      }
      const bookings = await bookingRepo.getWaitlist(eventDate || null);
      res.json({ success: true, count: bookings.length, bookings });
    } catch (error) { next(error); }
  }

  async addToWaitlist(req, res, next) {
    try {
      const bookingId = Number.parseInt(req.params.id, 10);
      if (!Number.isInteger(bookingId)) return res.status(400).json({ success: false, message: 'Invalid booking ID' });
      const reason = typeof req.body?.reason === 'string' ? req.body.reason.slice(0, 500) : null;
      const result = await schedulingService.addToWaitlist(bookingId, reason, req.correlationId);
      res.status(200).json(result);
    } catch (error) {
      if (error.status) return res.status(error.status).json({ success: false, message: error.message });
      if (error.message?.includes('not found')) return res.status(404).json({ success: false, message: error.message });
      next(error);
    }
  }

  async getDecisionEvents(req, res, next) {
    try {
      const limit = req.query.limit ? Number.parseInt(req.query.limit, 10) : 100;
      const bookingId = req.query.booking_id ? Number.parseInt(req.query.booking_id, 10) : null;
      if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
        return res.status(400).json({ success: false, message: 'limit must be between 1 and 500' });
      }
      if (req.query.booking_id && (!Number.isInteger(bookingId) || bookingId < 1)) {
        return res.status(400).json({ success: false, message: 'booking_id must be a positive integer' });
      }
      const events = await bookingRepo.getDecisionEvents({ limit, bookingId });
      res.json({ success: true, count: events.length, events });
    } catch (error) { next(error); }
  }

  async createBookingSeries(req, res, next) {
    try {
      const idempotencyKey = req.headers['idempotency-key'];
      if (idempotencyKey && (typeof idempotencyKey !== 'string' || idempotencyKey.length > 255)) {
        return res.status(400).json({ success: false, message: 'Idempotency-Key must be a string of at most 255 characters' });
      }
      const { occurrences, every_days, all_or_nothing, ...bookingRequest } = req.body || {};
      const result = await schedulingService.createBookingSeries(
        bookingRequest,
        { occurrences, every_days, all_or_nothing },
        req.correlationId,
        idempotencyKey,
        req.user
      );
      res.status(result.success ? 201 : 409).json(result);
    } catch (error) {
      if (error.name === 'ZodError') {
        return res.status(400).json({ success: false, message: 'Validation failed', errors: error.errors });
      }
      if (error.status) return res.status(error.status).json({ success: false, message: error.message });
      next(error);
    }
  }

  /**
   * Get data-derived booking statistics and a clearly defined 30-day venue utilization metric.
   */
  async getStats(req, res, next) {
    try {
      const { query } = await import('../database/config.js');
      const counts = await query(`
        SELECT
          COUNT(*)::int AS total,
          COUNT(*) FILTER (WHERE status = 'confirmed')::int AS confirmed,
          COUNT(*) FILTER (WHERE status = 'cancelled')::int AS cancelled,
          COUNT(*) FILTER (WHERE status = 'rejected')::int AS rejected,
          COUNT(*) FILTER (WHERE status = 'waitlisted')::int AS waitlisted,
          COUNT(*) FILTER (WHERE status = 'confirmed' AND event_date >= CURRENT_DATE)::int AS upcoming
        FROM bookings
      `);

      const utilization = await query(`
        WITH active_halls AS (
          SELECT venue_id, COUNT(*)::numeric AS hall_count
          FROM halls WHERE is_active = true GROUP BY venue_id
        ), period_bookings AS (
          SELECT b.venue_id, b.id,
                 EXTRACT(EPOCH FROM (b.reserved_end - b.reserved_start)) / 3600.0 AS reserved_hours
          FROM bookings b
          WHERE b.status = 'confirmed'
            AND b.event_date >= CURRENT_DATE
            AND b.event_date < CURRENT_DATE + INTERVAL '30 days'
        )
        SELECT v.id AS venue_id, v.name,
               COUNT(pb.id)::int AS booking_count,
               ROUND(COALESCE(SUM(pb.reserved_hours), 0)::numeric, 2) AS reserved_hours,
               ROUND((COALESCE(ah.hall_count, 0) * 14 * 30)::numeric, 2) AS available_hall_hours,
               CASE WHEN COALESCE(ah.hall_count, 0) = 0 THEN 0
                    ELSE ROUND((COALESCE(SUM(pb.reserved_hours), 0) / (ah.hall_count * 14 * 30) * 100)::numeric, 2)
               END AS utilization_pct,
               CURRENT_DATE AS period_start,
               CURRENT_DATE + 29 AS period_end
        FROM venues v
        LEFT JOIN active_halls ah ON ah.venue_id = v.id
        LEFT JOIN period_bookings pb ON pb.venue_id = v.id
        GROUP BY v.id, v.name, ah.hall_count
        ORDER BY v.id
      `);

      res.json({
        success: true,
        stats: {
          ...counts.rows[0],
          venueUtilization: utilization.rows,
          utilizationDefinition: 'Confirmed reserved hall-hours divided by active hall-hours available during the next 30 calendar days (14 operating hours per hall per day).'
        }
      });
    } catch (error) {
      next(error);
    }
  }
}

export default new BookingController();
