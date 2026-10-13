import React from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { ArrowLeft, Compass, Home } from 'lucide-react';

/**
 * A real "not found" (F-05). A link that points nowhere — an old bookmark, a
 * deleted thing, a mistyped address — used to render a blank page inside the
 * shell, or bounce a signed-in person to the sign-in screen.
 */
export const NotFound: React.FC = () => {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  return (
    <div className="grid min-h-full place-items-center px-6 py-16">
      <div className="max-w-md text-center">
        <span className="mx-auto mb-4 grid h-14 w-14 place-items-center rounded-2xl bg-blue-50 text-blue-600 dark:bg-blue-500/10 dark:text-blue-300">
          <Compass size={26} />
        </span>
        <h1 className="text-xl font-bold text-text-primary-light dark:text-text-primary-dark">This page isn’t here</h1>
        <p className="mt-2 text-sm text-text-secondary-light dark:text-text-secondary-dark">
          The link may be old, or what it pointed to was removed. Check the address, or carry on from Tupo’s home.
        </p>
        <p className="mt-2 break-all font-mono text-xs text-text-secondary-light/80 dark:text-text-secondary-dark/80">{pathname}</p>
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
