import express from 'express';
import bookingController from '../../controllers/BookingController.js';
import venueController from '../../controllers/VenueController.js';
import { query } from '../../database/config.js';
import { requireRoles } from '../../middleware/supabaseAuth.js';

// Self-service portal for approved client accounts. Every route is scoped to the
// client record linked to the signed-in user; the client_id in a request body is
// always overwritten, and the create_booking RPC enforces the same mapping.
const router = express.Router();

router.use(requireRoles('client'), (req, res, next) => {
  if (req.authMode !== 'local' && !req.user?.clientId) {
    return res.status(403).json({ success: false, error: 'ApprovalRequired', message: 'Your account is awaiting administrator approval.' });
  }
  return next();
});

router.get('/venues', venueController.getAllVenues.bind(venueController));

router.get('/bookings', async (req, res, next) => {
  try {
    const result = await query(`
      SELECT b.id, b.event_name, b.event_date, b.event_start, b.event_end, b.attendees, b.status,
             b.rejection_reason, b.projectors_requested, b.audio_systems_requested, b.staff_requested,
             b.created_at, pv.name AS preferred_venue_name, v.name AS venue_name, h.name AS hall_name
      FROM public.bookings b
      LEFT JOIN public.venues pv ON pv.id = b.preferred_venue_id
      LEFT JOIN public.venues v ON v.id = b.venue_id
      LEFT JOIN public.halls h ON h.id = b.hall_id
      WHERE b.client_id = $1
      ORDER BY b.event_date DESC, b.event_start DESC
    `, [req.user.clientId]);
    res.json({ success: true, count: result.rows.length, bookings: result.rows });
  } catch (error) {
    next(error);
  }
});

router.post('/bookings', (req, res, next) => {
  req.body = { ...req.body, client_id: req.user.clientId };
  return bookingController.createBooking(req, res, next);
});

export default router;
