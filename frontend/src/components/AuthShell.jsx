import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { ShieldCheck, LogIn, LogOut, AlertTriangle, Loader2, UserPlus } from 'lucide-react';
import api from '../services/api';
import { clearSession, isSupabaseAuthConfigured, restoreSession, signInWithGoogle, signInWithPassword, signOut, signUpWithPassword } from '../services/auth';

// The verified EventSync profile, or null in local demo mode (which has full access).
const ProfileContext = createContext(null);
export const useProfile = () => useContext(ProfileContext);

function LoginScreen({ onSignedIn, initialError = '' }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [mode, setMode] = useState('signin');
  const [error, setError] = useState(initialError);
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const registering = mode === 'register';

  const switchMode = next => { setMode(next); setError(''); setNotice(''); setPassword(''); setConfirmPassword(''); };

  const submit = async event => {
    event.preventDefault(); setError(''); setNotice('');
    if (registering) {
      if (password.length < 8) { setError('Password must be at least 8 characters.'); return; }
      if (password !== confirmPassword) { setError('Passwords do not match.'); return; }
    }
    setBusy(true);
    try {
      if (registering) {
        const { confirmationRequired } = await signUpWithPassword(email, password, displayName);
        if (confirmationRequired) {
          switchMode('signin');
          setNotice('Account created. An administrator must approve it before you can sign in.');
          return;
        }
      } else {
        await signInWithPassword(email, password);
      }
      await onSignedIn();
    }
    catch (err) {
      const message = err.response?.data?.message || err.message || (registering ? 'Unable to register.' : 'Unable to sign in.');
      setError(/email not confirmed/i.test(message) ? 'Your account is awaiting administrator approval. Please try again once it is approved.' : message);
    }
    finally { setBusy(false); }
  };

  return <div className="auth-screen min-h-screen grid place-items-center bg-slate-950 p-4">
    <div className="auth-card w-full max-w-md rounded-2xl border border-slate-200/10 bg-white p-8 shadow-2xl">
      <div className="mb-7 flex items-center gap-3"><div className="grid h-12 w-12 place-items-center rounded-xl bg-indigo-600 text-white"><ShieldCheck className="h-6 w-6" /></div><div><h1 className="text-2xl font-bold text-slate-900">EventSync</h1><p className="text-sm text-slate-500">Secure operations workspace</p></div></div>
      <h2 className="text-lg font-semibold text-slate-900">{registering ? 'Create your account' : 'Sign in to continue'}</h2>
      <p className="mt-1 text-sm text-slate-500">{registering ? 'Register with your email address.' : 'Use your EventSync staff or manager account.'}</p>
      {error && <div role="alert" className="mt-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</div>}
      {notice && <div role="status" className="mt-4 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-700">{notice}</div>}
      <form onSubmit={submit} className="mt-5 space-y-4">
        {registering && <label className="block text-sm font-medium text-slate-700">Full name<input className="input mt-1 w-full" type="text" autoComplete="name" value={displayName} onChange={e => setDisplayName(e.target.value)} /></label>}
        <label className="block text-sm font-medium text-slate-700">Email<input className="input mt-1 w-full" type="email" autoComplete="username" required value={email} onChange={e => setEmail(e.target.value)} /></label>
        <label className="block text-sm font-medium text-slate-700">Password<input className="input mt-1 w-full" type="password" autoComplete={registering ? 'new-password' : 'current-password'} required minLength={registering ? 8 : undefined} value={password} onChange={e => setPassword(e.target.value)} /></label>
        {registering && <label className="block text-sm font-medium text-slate-700">Confirm password<input className="input mt-1 w-full" type="password" autoComplete="new-password" required value={confirmPassword} onChange={e => setConfirmPassword(e.target.value)} /></label>}
        <button className="btn btn-primary w-full justify-center" disabled={busy}>{busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : registering ? <UserPlus className="mr-2 h-4 w-4" /> : <LogIn className="mr-2 h-4 w-4" />}{registering ? 'Create account' : 'Sign in'}</button>
      </form>
      <p className="mt-3 text-center text-sm text-slate-500">{registering ? 'Already have an account?' : 'New to EventSync?'} <button type="button" className="font-medium text-indigo-600 hover:underline" onClick={() => switchMode(registering ? 'signin' : 'register')}>{registering ? 'Sign in' : 'Register'}</button></p>
      <div className="my-4 flex items-center gap-3 text-xs text-slate-400"><div className="h-px flex-1 bg-slate-200" />OR<div className="h-px flex-1 bg-slate-200" /></div>
      <button className="btn btn-secondary w-full justify-center" onClick={() => signInWithGoogle().catch(err => setError(err.message))}>Continue with Google</button>
      <p className="mt-5 text-xs leading-relaxed text-slate-500">Access is controlled by your EventSync profile role. Newly registered users start with the client role and must be assigned an operational role by an administrator.</p>
    </div>
  </div>;
}

export default function AuthShell({ children }) {
  const configured = isSupabaseAuthConfigured;
  const [ready, setReady] = useState(!configured);
  const [session, setSession] = useState(null);
  const [profile, setProfile] = useState(null);
  const [error, setError] = useState('');

  const verifyProfile = useCallback(async () => {
    const response = await api.get('/auth/me');
    const nextProfile = response.data?.user;
    const approvedClient = nextProfile?.role === 'client' && nextProfile.client_id;
    if (!nextProfile || !(['admin', 'manager', 'staff'].includes(nextProfile.role) || approvedClient)) {
      throw new Error(nextProfile?.role === 'client'
        ? 'Your account is registered and awaiting administrator approval. An admin will approve it shortly.'
        : `Your EventSync role is ${nextProfile?.role || 'unassigned'}. Ask an administrator for access.`);
    }
    setProfile(nextProfile);
    setError('');
  }, []);

  const initialize = useCallback(async () => {
    if (!configured) { setReady(true); return; }
    try {
      const restored = await restoreSession();
      setSession(restored);
      if (restored) await verifyProfile();
    } catch (err) {
      setError(err.response?.data?.message || err.message || 'Could not validate your EventSync profile.');
    } finally { setReady(true); }
  }, [configured, verifyProfile]);

  useEffect(() => { initialize(); }, [initialize]);

  useEffect(() => {
    const onSessionExpired = () => {
      setSession(null);
      setProfile(null);
      setError('Your session expired. Please sign in again.');
      setReady(true);
    };
    window.addEventListener('eventsync:auth-expired', onSessionExpired);
    return () => window.removeEventListener('eventsync:auth-expired', onSessionExpired);
  }, []);

  const handleSignIn = async () => {
    const restored = await restoreSession();
    setSession(restored);
    try { await verifyProfile(); }
    catch (err) {
      const message = err.response?.data?.message || err.message || 'Could not validate your EventSync profile.';
      setError(message);
      throw err;
    }
  };
  const handleSignOut = async () => {
    await signOut(); setSession(null); setProfile(null); setError('');
  };

  if (!configured) return <><div className="flex items-center justify-center gap-2 bg-amber-50 px-3 py-2 text-center text-xs font-medium text-amber-900"><AlertTriangle className="h-4 w-4" />Local demo mode: Supabase Auth is not configured. Do not expose this mode publicly.</div>{children}</>;
  if (!ready) return <div className="auth-screen grid min-h-screen place-items-center bg-slate-950 text-white"><div className="flex items-center gap-3"><Loader2 className="h-5 w-5 animate-spin" />Checking secure session…</div></div>;
  if (!session) return <LoginScreen initialError={error} onSignedIn={handleSignIn} />;
  if (error) return <div className="auth-screen grid min-h-screen place-items-center bg-slate-950 p-4"><div className="auth-card w-full max-w-lg rounded-2xl bg-white p-8"><AlertTriangle className="mb-3 h-8 w-8 text-amber-600" /><h1 className="text-xl font-bold text-slate-900">Awaiting approval</h1><p className="mt-2 text-sm text-slate-600">{error}</p><button className="btn btn-primary mt-6" onClick={handleSignOut}><LogOut className="mr-2 h-4 w-4" />Sign out</button></div></div>;

  return <><div className="flex items-center justify-between gap-3 bg-slate-950 px-4 py-2 text-xs text-white"><div className="flex min-w-0 items-center gap-2"><ShieldCheck className="h-4 w-4 shrink-0 text-emerald-400" /><span className="truncate">Secure session · {profile?.display_name || profile?.email || session.user?.email} · {profile?.role}</span></div><button className="flex shrink-0 items-center gap-1 rounded-md px-2 py-1 hover:bg-white/10" onClick={handleSignOut}><LogOut className="h-3.5 w-3.5" />Sign out</button></div><ProfileContext.Provider value={profile}>{children}</ProfileContext.Provider></>;
}
