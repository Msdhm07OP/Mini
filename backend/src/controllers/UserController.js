import { query } from '../database/config.js';

const ROLES = ['admin', 'manager', 'staff', 'client'];

class UserController {
  /**
   * List every registered account with its EventSync role (admin only)
   */
  async listUsers(req, res, next) {
    try {
      const result = await query(`
        SELECT u.id AS user_id, u.email, p.role, p.display_name,
               u.email_confirmed_at IS NOT NULL AS email_confirmed,
               u.created_at, u.last_sign_in_at
        FROM auth.users u
        JOIN public.user_profiles p ON p.user_id = u.id
        ORDER BY (p.role = 'client') DESC, u.created_at DESC
      `);
      res.json({ success: true, count: result.rows.length, users: result.rows });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Approve an account by assigning an operational role (admin only).
   * Approval also confirms the email so the user can sign in immediately.
   */
  async updateRole(req, res, next) {
    try {
      const { role } = req.body || {};
      if (!ROLES.includes(role)) {
        return res.status(400).json({ success: false, error: 'ValidationError', message: `Role must be one of: ${ROLES.join(', ')}.` });
      }
      if (req.user?.id && req.user.id === req.params.userId && role !== 'admin') {
        return res.status(400).json({ success: false, error: 'ValidationError', message: 'You cannot remove your own admin role.' });
      }
      const result = await query(
        `UPDATE public.user_profiles
         SET role = $2::text, client_id = CASE WHEN $2::text = 'client' THEN client_id ELSE NULL END, updated_at = NOW()
         WHERE user_id = $1::uuid
         RETURNING user_id, role`,
        [req.params.userId, role],
      );
      if (!result.rows.length) {
        return res.status(404).json({ success: false, error: 'NotFound', message: 'User not found.' });
      }
      if (role !== 'client') {
        await query('UPDATE auth.users SET email_confirmed_at = COALESCE(email_confirmed_at, NOW()) WHERE id = $1::uuid', [req.params.userId]);
      }
      res.json({ success: true, user: result.rows[0] });
    } catch (error) {
      next(error);
    }
  }
}

export default new UserController();
