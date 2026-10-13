import React from 'react';
import { CloudOff, RotateCcw } from 'lucide-react';

/**
 * The one way a screen says "this did not load" (F-06).
 *
 * A failed request used to fall through to the empty state — "No audit
 * entries yet", "Nothing matches" — which tells someone the opposite of the
 * truth. Every list that can fail to load shows this instead, with a retry.
 */
export const LoadError: React.FC<{
  /** What did not load, e.g. "the audit log". */
  what?: string;
  onRetry?: () => void;
  /** Smaller, for a panel or a dropdown rather than a whole page. */
  compact?: boolean;
  /** The server's own message, when it gave one worth showing. */
  detail?: string | null;
}> = ({ what, onRetry, compact = false, detail }) => (
  <div role="alert" className={`flex flex-col items-center text-center ${compact ? 'gap-1.5 px-4 py-8' : 'gap-2 px-6 py-14'}`}>
    <span className={`grid place-items-center rounded-full bg-amber-100 text-amber-600 dark:bg-amber-500/15 dark:text-amber-400 ${compact ? 'h-9 w-9' : 'h-12 w-12'}`}>
      <CloudOff size={compact ? 16 : 20} />
    </span>
    <p className="text-sm font-semibold text-text-primary-light dark:text-text-primary-dark">
      {what ? `Couldn’t load ${what}` : 'Something went wrong'}
    </p>
    <p className="max-w-xs text-xs text-text-secondary-light dark:text-text-secondary-dark">
      {detail || 'Check your connection and try again. Nothing was lost.'}
    </p>
    {onRetry && (
      <button
        onClick={onRetry}
        className="mt-1 inline-flex items-center gap-1.5 rounded-full bg-blue-600 px-3.5 py-1.5 text-xs font-medium text-white hover:bg-blue-700"
      >
        <RotateCcw size={13} /> Try again
      </button>
    )}
  </div>
);
