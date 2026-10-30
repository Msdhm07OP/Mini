import express from 'express';
import venueController from '../../controllers/VenueController.js';

const router = express.Router();

router.get('/', venueController.getAllVenues.bind(venueController));
router.get('/:id', venueController.getVenueById.bind(venueController));
router.get('/:id/bookings', venueController.getVenueBookings.bind(venueController));

export default router;
