import express from 'express';
import bookingController from '../../controllers/BookingController.js';

const router = express.Router();

// Booking CRUD operations
router.post('/', bookingController.createBooking.bind(bookingController));
router.get('/', bookingController.getBookings.bind(bookingController));
router.get('/stats', bookingController.getStats.bind(bookingController));
router.get('/waitlist', bookingController.getWaitlist.bind(bookingController));
router.get('/decisions', bookingController.getDecisionEvents.bind(bookingController));
router.post('/series', bookingController.createBookingSeries.bind(bookingController));
router.get('/:id', bookingController.getBookingById.bind(bookingController));

// Booking actions
router.post('/:id/cancel', bookingController.cancelBooking.bind(bookingController));
router.post('/:id/waitlist', bookingController.addToWaitlist.bind(bookingController));
router.put('/:id/reschedule', bookingController.rescheduleBooking.bind(bookingController));

// Alternative slots
router.post('/alternatives', bookingController.getAlternatives.bind(bookingController));

export default router;
