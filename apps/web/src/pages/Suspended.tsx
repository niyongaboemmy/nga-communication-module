import React from 'react';
import { ShieldOff } from 'lucide-react';
import { Logo } from '../components/Logo';

/**
 * Where a suspended account lands (A-11) — at sign-in, or the moment a session
 * finds out mid-use. One honest screen instead of an app whose every request
 * fails behind empty states. No retry: only an administrator can lift this.
 */
export const Suspended: React.FC = () => (
  <div className="grid min-h-full place-items-center bg-slate-50 px-4 dark:bg-chrome-dark">
    <div className="w-full max-w-md rounded-xl border border-slate-200 bg-white p-8 text-center dark:border-border-dark dark:bg-elevated-dark">
      <Logo size={36} className="mx-auto mb-4" decorative />
      <div className="mx-auto mb-4 grid h-12 w-12 place-items-center rounded-full bg-red-50 text-red-600 dark:bg-red-950/50 dark:text-red-400">
        <ShieldOff size={24} />
      </div>
      <h1 className="text-base font-semibold text-slate-900 dark:text-slate-50">Your Tupo account is suspended</h1>
      <p className="mx-auto mt-2 max-w-sm text-sm leading-relaxed text-slate-500 dark:text-slate-400">
        You cannot use Tupo while your account is suspended. If you think this is a mistake,
        contact the school office or your administrator.
      </p>
    </div>
  </div>
);
