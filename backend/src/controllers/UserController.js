import { query } from '../database/config.js';

const ROLES = ['admin', 'manager', 'staff', 'client'];

class UserController {
  /**
   * List every registered account with its EventSync role (admin only)
   */
  async listUsers(req, res, next) {
    try {
      const result = await query(`
        SELECT u.id AS user_id, u.email, p.role, p.display_name, p.client_id,
               u.email_confirmed_at IS NOT NULL AS email_confirmed,
               u.created_at, u.last_sign_in_at
        FROM auth.users u
        JOIN public.user_profiles p ON p.user_id = u.id
        ORDER BY (p.role = 'client' AND p.client_id IS NULL) DESC, u.created_at DESC
      `);
      res.json({ success: true, count: result.rows.length, users: result.rows });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Approve an account by assigning a role (admin only). Approving as a client
   * links the account to a client record, reusing one with the same email.
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
      const account = await query(
        `SELECT u.email, p.display_name, p.client_id
         FROM auth.users u JOIN public.user_profiles p ON p.user_id = u.id
         WHERE u.id = $1::uuid`,
        [req.params.userId],
      );
      if (!account.rows.length) {
        return res.status(404).json({ success: false, error: 'NotFound', message: 'User not found.' });
      }

      let clientId = null;
      if (role === 'client') {
        const { email, display_name: displayName, client_id: existing } = account.rows[0];
        clientId = existing;
        if (!clientId) {
          const match = await query('SELECT id FROM public.clients WHERE lower(email) = lower($1) ORDER BY id LIMIT 1', [email]);
          clientId = match.rows[0]?.id || (await query(
            'INSERT INTO public.clients (name, email) VALUES ($1, $2) RETURNING id',
            [displayName || email, email],
          )).rows[0].id;
        }
      }

      const result = await query(
        `UPDATE public.user_profiles SET role = $2::text, client_id = $3, updated_at = NOW()
         WHERE user_id = $1::uuid
         RETURNING user_id, role, client_id`,
        [req.params.userId, role, clientId],
      );
      await query('UPDATE auth.users SET email_confirmed_at = COALESCE(email_confirmed_at, NOW()) WHERE id = $1::uuid', [req.params.userId]);
      res.json({ success: true, user: result.rows[0] });
    } catch (error) {
      next(error);
    }
  }
}

export default new UserController();
