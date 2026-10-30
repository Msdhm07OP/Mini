import express from 'express';
import clientController from '../../controllers/ClientController.js';

const router = express.Router();

router.get('/', clientController.getAllClients.bind(clientController));
router.post('/', clientController.createClient.bind(clientController));
router.get('/:id', clientController.getClientById.bind(clientController));
router.get('/:id/bookings', clientController.getClientBookings.bind(clientController));

export default router;
