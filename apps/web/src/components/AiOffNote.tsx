import React from 'react';
import { Sparkles } from 'lucide-react';

/**
 * Shown where an AI action would be when the school has turned AI off (MIS
 * ai_policy). A note, not a disabled button: there is nothing the user can do
 * about it, so there is nothing to press.
 */
export const AiOffNote: React.FC<{ message: string; className?: string }> = ({ message, className = '' }) => (
  <span
    role="note"
    title="Only a super administrator can turn AI back on."
    className={`inline-flex items-center gap-1.5 rounded-full border border-border-light px-2.5 py-1 text-xs text-text-secondary-light dark:border-border-dark/60 dark:text-text-secondary-dark ${className}`}
  >
    <Sparkles size={13} className="opacity-60" /> {message}
  </span>
);
