import { query } from '../database/config.js';

const mode = (process.env.AUTH_MODE || 'auto').toLowerCase();
const supabaseUrl = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY || '';
const authConfigured = Boolean(supabaseUrl && supabaseAnonKey);

export function isSupabaseAuthRequired() {
  if (mode === 'required') return true;
  if (mode === 'disabled' || mode === 'local') return false;
  return authConfigured || process.env.NODE_ENV === 'production';
}

export function validateAuthConfiguration() {
  if (process.env.NODE_ENV === 'production' && (mode === 'disabled' || mode === 'local')) {
    throw new Error('Refusing to start in production with AUTH_MODE=disabled/local. Configure Supabase Auth.');
  }
  if (isSupabaseAuthRequired() && !authConfigured) {
    throw new Error('Supabase Auth is required but SUPABASE_URL and SUPABASE_ANON_KEY are not configured.');
  }
}

export async function authenticateSupabase(req, res, next) {
  if (!isSupabaseAuthRequired()) {
    req.authMode = 'local';
    req.user = { id: null, email: null, role: 'admin', clientId: null, localDemo: true };
    return next();
  }

  const header = req.get('authorization') || '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    return res.status(401).json({ success: false, error: 'Unauthorized', message: 'A valid Supabase access token is required.' });
  }

  try {
    const authResponse = await fetch(`${supabaseUrl}/auth/v1/user`, {
      method: 'GET',
      headers: { apikey: supabaseAnonKey, Authorization: `Bearer ${match[1]}` },
      signal: AbortSignal.timeout(8000),
    });
    if (!authResponse.ok) {
      if (authResponse.status >= 500) {
        return res.status(503).json({ success: false, error: 'AuthUnavailable', message: 'Supabase Auth is temporarily unavailable. Please retry.' });
      }
      return res.status(401).json({ success: false, error: 'Unauthorized', message: 'The Supabase session is invalid or has expired. Please sign in again.' });
    }
    const authUser = await authResponse.json();
    if (!authUser?.id) {
      return res.status(401).json({ success: false, error: 'Unauthorized', message: 'Supabase did not return a valid user.' });
    }

    const profileResult = await query(
      'SELECT user_id, role, client_id, display_name FROM public.user_profiles WHERE user_id = $1::uuid',
      [authUser.id],
    );
    if (!profileResult.rows.length) {
      return res.status(403).json({
        success: false,
        error: 'ProfileRequired',
        message: 'Your account exists, but it has no EventSync profile yet. Ask an administrator to link your client account or assign an operational role.',
      });
    }

    const profile = profileResult.rows[0];
    req.authMode = 'supabase';
    req.user = {
      id: profile.user_id,
      email: authUser.email || null,
      role: profile.role,
      clientId: profile.client_id,
      displayName: profile.display_name,
    };
    return next();
  } catch (error) {
    if (error.name === 'TimeoutError' || error.name === 'AbortError' || error.name === 'TypeError') {
      return res.status(503).json({ success: false, error: 'AuthUnavailable', message: 'Supabase Auth could not be reached. Please retry.' });
    }
    return next(error);
  }
}

export function requireRoles(...allowedRoles) {
  return (req, res, next) => {
    if (req.authMode === 'local') return next();
    if (!req.user || !allowedRoles.includes(req.user.role)) {
      return res.status(403).json({
        success: false,
        error: 'Forbidden',
        message: `This operation requires one of these EventSync roles: ${allowedRoles.join(', ')}.`,
      });
    }
    return next();
  };
}

export const requireOperationsRole = requireRoles('admin', 'manager', 'staff');
export const requireManagementRole = requireRoles('admin', 'manager');
export const requireAdminRole = requireRoles('admin');
