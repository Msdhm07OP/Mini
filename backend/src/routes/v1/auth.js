import express from 'express';
import authController from '../../controllers/AuthController.js';
const router = express.Router();
router.get('/me', authController.me.bind(authController));
export default router;
