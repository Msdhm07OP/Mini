import express from 'express';
import userController from '../../controllers/UserController.js';

const router = express.Router();

router.get('/', userController.listUsers.bind(userController));
router.patch('/:userId/role', userController.updateRole.bind(userController));

export default router;
