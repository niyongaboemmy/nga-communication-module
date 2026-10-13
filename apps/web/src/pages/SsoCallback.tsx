import React, { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AlertCircle, ArrowLeft } from 'lucide-react';
import { Logo } from '../components/Logo';
import { useAuth } from '../context/AuthContext';
import type { SsoExchangeResult } from '@tupo/shared';
import { consumeSsoState } from '../lib/ssoState';
import { SESSION_KEY, USER_KEY } from '../lib/api';

/** Where the MIS sends the user back to. Exchanges the code for a Tupo session. */
export const SsoCallback: React.FC = () => {
  const { setSession } = useAuth();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<{ result: SsoExchangeResult; currentName: string } | null>(null);
  const accept = (r: SsoExchangeResult) => {
    setSession(r.token, r.user, r.permissions, r.rolePermissions ?? [], r.roleName ?? null);
    navigate('/app', { replace: true });
  };
  // React Strict Mode runs effects twice in development; an authorization code
  // is single-use, so a second exchange would always fail. Guard it.
  const exchanged = useRef(false);

  useEffect(() => {
    // First: a second run (StrictMode) finds the code already taken out of
    // the URL and must not mistake that for "opened without a code".
    if (exchanged.current) return;
    const code = new URLSearchParams(window.location.search).get('code');

    if (!code) {
      // Almost always someone opening /sso/callback directly rather than a real
      // redirect — send them to sign-in instead of a dead-end error.
      navigate('/', { replace: true });
      return;
    }
    exchanged.current = true;
    // The code is single-use: take it out of the address bar at once, so a
    // reload, Back, or a copied link can never replay it (F-08).
    const stateParam = new URLSearchParams(window.location.search).get('state');
    window.history.replaceState(window.history.state, '', '/sso/callback');

    // OAuth `state` (CSRF) check. Runs after the Strict Mode guard so the
    // stored value is consumed exactly once.
    const stateCheck = consumeSsoState(stateParam);
    if (!stateCheck.ok) {
      setError('This sign-in link did not come from a sign-in started in this browser tab. Please sign in again.');
      return;
    }
    if (stateCheck.reason !== 'match') {
      console.warn(`SSO callback: state not verified (${stateCheck.reason}); continuing.`);
    }

    (async () => {
      try {
        const res = await fetch('/api/sso/exchange', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code }),
        });
        const body = await res.json();
        if (res.ok && body.success) {
          const result = body.data as SsoExchangeResult;
          // Someone else is already signed in in this browser: ask before
          // replacing their session (it also signs out their other tabs).
          let current: { id?: string; name?: string } | null = null;
          try { current = localStorage.getItem(SESSION_KEY) ? JSON.parse(localStorage.getItem(USER_KEY) ?? 'null') : null; } catch { current = null; }
          if (current?.id && current.id !== result.user.id) {
            setPending({ result, currentName: current.name ?? 'someone else' });
            return;
          }
          accept(result);
        } else if (body.code === 'ACCOUNT_SUSPENDED') {
          navigate('/suspended', { replace: true });
        } else {
          setError(body.message ?? 'Sign-in failed. The code may have expired or already been used.');
        }
      } catch {
        setError('Could not reach the Tupo server. Please check your connection and try again.');
      }
    })();
  }, [navigate, setSession]);

  return (
    <div className="min-h-full grid place-items-center bg-slate-50 px-4 dark:bg-background-dark">
      <div className="w-full max-w-sm rounded-2xl border border-slate-200 bg-white p-8 text-center  dark:border-border-dark dark:bg-chrome-dark">
        {pending ? (
          <>
            <h1 className="text-base font-semibold text-slate-900 dark:text-slate-50">Switch account?</h1>
            <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">
              {pending.currentName} is signed in to Tupo in this browser. Continue as {pending.result.user.name}? Their other Tupo tabs will switch too.
            </p>
            <div className="mt-5 flex flex-col gap-2">
              <button onClick={() => accept(pending.result)} className="rounded-full bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700">
                Continue as {pending.result.user.name}
              </button>
              <button onClick={() => navigate('/app', { replace: true })} className="rounded-full border border-slate-200 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 dark:border-border-dark dark:text-slate-200">
                Stay as {pending.currentName}
              </button>
            </div>
          </>
        ) : !error ? (
          <>
            <div className="mx-auto mb-5 h-8 w-8 animate-spin rounded-full border-2 border-slate-200 border-t-brand-500" />
            <h1 className="text-base font-semibold text-slate-900 dark:text-slate-50">Verifying your session</h1>
            <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">Securely signing you in with NGA MIS…</p>
          </>
        ) : (
          <>
            <div className="mx-auto mb-4 grid h-11 w-11 place-items-center rounded-full bg-red-50 text-red-600 dark:bg-red-950">
              <AlertCircle size={22} />
            </div>
            <h1 className="text-base font-semibold text-slate-900 dark:text-slate-50">Sign-in failed</h1>
            <p className="mt-1 mb-6 text-sm text-slate-500 dark:text-slate-400">{error}</p>
            <button
              onClick={() => navigate('/')}
              className="flex w-full items-center justify-center gap-2 rounded-lg border border-slate-200 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 dark:border-border-dark dark:text-slate-200 dark:hover:bg-elevated-dark"
            >
              <ArrowLeft size={15} /> Back to sign in
            </button>
          </>
        )}
      </div>
    </div>
  );
};
