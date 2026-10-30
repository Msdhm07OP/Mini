import express from 'express';
import analyticsController from '../../controllers/AnalyticsController.js';

const router = express.Router();

// Read-only what-if evaluation. Creates no booking and reserves no resources.
router.post('/', analyticsController.simulate.bind(analyticsController));

export default router;
