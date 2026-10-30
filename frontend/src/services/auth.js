const supabaseUrl = (import.meta.env.VITE_SUPABASE_URL || '').replace(/\/$/, '');
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY || '';
const STORAGE_KEY = 'eventsync.supabase.session.v1';
const PKCE_VERIFIER_KEY = 'eventsync.supabase.pkce.verifier.v1';
let refreshPromise = null;

export const isSupabaseAuthConfigured = Boolean(supabaseUrl && supabaseAnonKey);

function saveSession(session) {
  if (!session?.access_token) throw new Error('Supabase did not return an access token.');
  const normalized = {
    ...session,
    expires_at: session.expires_at || (session.expires_in ? Math.floor(Date.now() / 1000) + session.expires_in : null),
  };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(normalized));
  return normalized;
}

export function clearSession() {
  localStorage.removeItem(STORAGE_KEY);
}

function base64UrlEncode(bytes) {
  let binary = '';
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

async function createPkceChallenge() {
  if (!window.crypto?.subtle || !window.crypto?.getRandomValues) {
    throw new Error('Secure OAuth requires a modern browser with Web Crypto support.');
  }
  const random = new Uint8Array(32);
  window.crypto.getRandomValues(random);
  const verifier = base64UrlEncode(random);
  const digest = await window.crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  sessionStorage.setItem(PKCE_VERIFIER_KEY, verifier);
  return base64UrlEncode(digest);
}

export function getAccessToken() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null')?.access_token || null; }
  catch { return null; }
}

async function requestAuth(path, body, method = 'POST') {
  const response = await fetch(`${supabaseUrl}/auth/v1/${path}`, {
    method,
    headers: { apikey: supabaseAnonKey, 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.msg || payload.message || payload.error_description || payload.error || 'Supabase authentication failed.');
  return payload;
}

export async function signInWithPassword(email, password) {
  const session = await requestAuth('token?grant_type=password', { email: email.trim(), password });
  return saveSession(session);
}

// Supabase returns a session immediately when email confirmation is disabled;
// otherwise it returns only the user and the caller must confirm by email first.
// The on_auth_user_created trigger creates the EventSync profile with the client role.
export async function signUpWithPassword(email, password, displayName) {
  if (!isSupabaseAuthConfigured) throw new Error('Configure VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY first.');
  const redirectTo = `${window.location.origin}${window.location.pathname}`;
  const payload = await requestAuth(`signup?redirect_to=${encodeURIComponent(redirectTo)}`, {
    email: email.trim(),
    password,
    data: { display_name: displayName.trim() || undefined },
  });
  if (payload.access_token) return { session: saveSession(payload), confirmationRequired: false };
  return { session: null, confirmationRequired: true };
}

export async function signInWithGoogle() {
  if (!isSupabaseAuthConfigured) throw new Error('Configure VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY first.');
  const challenge = await createPkceChallenge();
  const redirectTo = `${window.location.origin}${window.location.pathname}`;
  const url = new URL(`${supabaseUrl}/auth/v1/authorize`);
  url.searchParams.set('provider', 'google');
  url.searchParams.set('redirect_to', redirectTo);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 's256');
  url.searchParams.set('apikey', supabaseAnonKey);
  window.location.assign(url.toString());
}

export async function restoreSession() {
  const query = new URLSearchParams(window.location.search);
  const authError = query.get('error_description') || query.get('error');
  if (authError) {
    sessionStorage.removeItem(PKCE_VERIFIER_KEY);
    const cleanUrl = `${window.location.pathname}${window.location.hash || ''}`;
    window.history.replaceState({}, document.title, cleanUrl);
    throw new Error(authError);
  }
  const code = query.get('code');
  if (code) {
    const verifier = sessionStorage.getItem(PKCE_VERIFIER_KEY);
    if (!verifier) throw new Error('The Google sign-in verifier is missing. Please start sign-in again.');
    try {
      const session = saveSession(await requestAuth('token?grant_type=pkce', { auth_code: code, code_verifier: verifier }));
      sessionStorage.removeItem(PKCE_VERIFIER_KEY);
      query.delete('code');
      const search = query.toString();
      window.history.replaceState({}, document.title, `${window.location.pathname}${search ? `?${search}` : ''}${window.location.hash || ''}`);
      return session;
    } catch (error) {
      sessionStorage.removeItem(PKCE_VERIFIER_KEY);
      throw error;
    }
  }
  const hash = new URLSearchParams(window.location.hash.replace(/^#/, ''));
  const accessToken = hash.get('access_token');
  if (accessToken) {
    const session = saveSession({
      access_token: accessToken,
      refresh_token: hash.get('refresh_token'),
      token_type: hash.get('token_type') || 'bearer',
      expires_in: Number(hash.get('expires_in') || 3600),
      expires_at: Number(hash.get('expires_at') || 0) || undefined,
    });
    window.history.replaceState({}, document.title, `${window.location.pathname}${window.location.search}`);
    return session;
  }

  let session;
  try { session = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null'); }
  catch { session = null; }
  if (!session?.access_token) return null;
  const expiresAt = Number(session.expires_at || 0);
  if (!expiresAt || expiresAt > Math.floor(Date.now() / 1000) + 45) return session;
  if (!session.refresh_token) { clearSession(); return null; }

  // A burst of API calls can arrive at the token-expiry boundary. Share one refresh
  // request so rotating refresh tokens are not accidentally submitted in parallel.
  if (!refreshPromise) {
    refreshPromise = requestAuth('token?grant_type=refresh_token', { refresh_token: session.refresh_token })
      .then(saveSession)
      .catch(() => { clearSession(); return null; })
      .finally(() => { refreshPromise = null; });
  }
  return refreshPromise;
}

export async function signOut() {
  const token = getAccessToken();
  try {
    if (token && isSupabaseAuthConfigured) {
      await fetch(`${supabaseUrl}/auth/v1/logout`, { method: 'POST', headers: { apikey: supabaseAnonKey, Authorization: `Bearer ${token}` } });
    }
  } finally { clearSession(); sessionStorage.removeItem(PKCE_VERIFIER_KEY); }
}
