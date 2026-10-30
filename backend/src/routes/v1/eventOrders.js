import express from 'express';
import controller from '../../controllers/EventOrderController.js';
const router = express.Router();
router.get('/', controller.list.bind(controller));
router.get('/:bookingId', controller.getOne.bind(controller));
router.put('/:bookingId', controller.update.bind(controller));
export default router;
