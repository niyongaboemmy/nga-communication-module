import React from 'react';
import { Navigate } from 'react-router-dom';
import { ShieldCheck, ArrowRight } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { Logo } from '../components/Logo';

/**
 * The entire sign-in surface of Tupo.
 *
 * There is no email field, no password field and no "create account" link —
 * and there must never be. Every account lives in the NGA Central MIS; this
 * screen's only job is to hand the user over to it.
 */
export const SignIn: React.FC = () => {
  const { signIn, isAuthenticated, loading } = useAuth();

  if (loading) return null;
  if (isAuthenticated) return <Navigate to="/app" replace />;

  return (
    <div className="grid min-h-full place-items-center bg-slate-50 px-4 dark:bg-chrome-dark">
      <main className="w-full max-w-sm">
        <div className="rounded-xl border border-slate-200 bg-white p-8  dark:border-border-dark dark:bg-elevated-dark">
          <div className="mb-6 flex items-center gap-3">
            <Logo size={40} decorative />
            <div>
              <h1 className="text-xl font-semibold tracking-tight text-slate-900 dark:text-slate-50">Tupo</h1>
              <p className="text-xs text-slate-500 dark:text-slate-400">NGA Communication Platform</p>
            </div>
          </div>

          <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">Sign in to continue</h2>
          <p className="mt-1 mb-6 text-sm leading-relaxed text-slate-500 dark:text-slate-400">
            Tupo uses your NGA Central MIS account. You will be redirected there to sign in,
            then brought straight back.
          </p>

          <button
            onClick={signIn}
            className="flex w-full items-center justify-center gap-2 rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-blue-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-slate-800"
          >
            Sign in with NGA MIS <ArrowRight size={16} />
          </button>

          <p className="mt-6 flex items-start gap-2 text-xs leading-relaxed text-slate-400 dark:text-slate-500">
            <ShieldCheck size={14} className="mt-0.5 shrink-0" />
            Tupo never stores your password. Authentication happens entirely in the NGA Central MIS.
          </p>
        </div>
      </main>
    </div>
  );
};
