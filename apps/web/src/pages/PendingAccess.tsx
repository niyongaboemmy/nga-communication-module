import React from 'react';
import { Clock, LogOut, RefreshCw } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { Button } from '../components/ui';
import { Logo } from '../components/Logo';

/**
 * Where a user lands when the MIS authenticated them but no Tupo role has been
 * assigned yet — `role_id IS NULL`, so they hold no permissions.
 *
 * This is deliberately a real state rather than a silent fallback to a default
 * role: guessing access for an unrecognised account is exactly the mistake a
 * school platform cannot afford.
 */
export const PendingAccess: React.FC = () => {
  const { user, signOut, refreshPermissions } = useAuth();
  const [checking, setChecking] = React.useState(false);

  const recheck = async () => {
    setChecking(true);
    await refreshPermissions();
    setChecking(false);
    window.location.reload();
  };

  return (
    <div className="grid min-h-full place-items-center bg-slate-50 px-4 dark:bg-slate-900">
      <div className="w-full max-w-md rounded-xl border border-slate-200 bg-white p-8 text-center dark:border-slate-700 dark:bg-slate-800">
        <Logo size={36} className="mx-auto mb-4" decorative />
        <div className="mx-auto mb-4 grid h-12 w-12 place-items-center rounded-full bg-amber-100 text-amber-600 dark:bg-amber-900/40 dark:text-amber-400">
          <Clock size={24} />
        </div>
        <h1 className="text-base font-semibold text-slate-900 dark:text-slate-50">Access pending</h1>
        <p className="mx-auto mt-2 max-w-sm text-sm leading-relaxed text-slate-500 dark:text-slate-400">
          You are signed in as <span className="font-medium text-slate-700 dark:text-slate-200">{user?.name}</span>,
          but an administrator has not yet assigned you a role in Tupo. You will get access as soon as they do.
        </p>
        <div className="mt-6 flex justify-center gap-2">
          <Button variant="secondary" onClick={recheck} disabled={checking}>
            <RefreshCw size={15} className={checking ? 'animate-spin' : ''} /> Check again
          </Button>
          <Button variant="ghost" onClick={signOut}>
            <LogOut size={15} /> Sign out
          </Button>
        </div>
      </div>
    </div>
  );
};
