import React from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowLeft, Home, Lock } from 'lucide-react';

/**
 * "This isn't open to you" (F-07): what the screen is not, in words, and two
 * ways out. It used to list raw permission keys ("Requires one of:
 * USERS_VIEW, USERS_MANAGE"), which tells nobody anything useful.
 */
export const AccessDenied: React.FC<{ area?: string }> = ({ area }) => {
  const navigate = useNavigate();
  return (
    <div className="grid min-h-full place-items-center px-6 py-16">
      <div role="alert" className="max-w-md text-center">
        <span className="mx-auto mb-4 grid h-14 w-14 place-items-center rounded-2xl bg-slate-100 text-slate-500 dark:bg-card-dark/60 dark:text-slate-300">
          <Lock size={24} />
        </span>
        <h1 className="text-xl font-bold text-text-primary-light dark:text-text-primary-dark">
          {area ? `${area} isn’t open to you` : 'This area isn’t open to you'}
        </h1>
        <p className="mt-2 text-sm text-text-secondary-light dark:text-text-secondary-dark">
          Your role doesn’t include it. If you need it for your work, ask a Tupo administrator to add it to your role.
        </p>
        <div className="mt-6 flex flex-wrap justify-center gap-2">
          <button
            onClick={() => navigate(-1)}
            className="inline-flex items-center gap-1.5 rounded-full border border-border-light px-4 py-2 text-sm font-medium text-text-primary-light hover:bg-surface-light dark:border-border-dark/50 dark:text-text-primary-dark dark:hover:bg-surface-dark"
          >
            <ArrowLeft size={15} /> Go back
          </button>
          <Link to="/app" className="inline-flex items-center gap-1.5 rounded-full bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700">
            <Home size={15} /> Tupo home
          </Link>
        </div>
      </div>
    </div>
  );
};
