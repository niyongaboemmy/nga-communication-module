import React from 'react';
import type { WireMessage } from '@tupo/shared';

/**
 * The message a reply answers, drawn inside the reply's bubble (FR-MSG-7).
 *
 * R-01: the quote used to be one `nowrap` line, which set the bubble's
 * natural width to the whole quoted sentence and pushed the bubble — and on a
 * phone the reply's own words — off the screen. It now wraps and is clamped
 * to two lines, inside a tinted block (the NGA UI rules allow no accent strip).
 *
 * Tappable: it jumps to the original, fetching the surrounding page first if
 * the original is not loaded.
 */
export const QuotePreview: React.FC<{
  replyTo: NonNullable<WireMessage['replyTo']>;
  onDark: boolean;
  onJump: () => void;
}> = ({ replyTo, onDark, onJump }) => (
  <button
    type="button"
    onClick={onJump}
    className={`mb-1.5 block w-full min-w-0 rounded-lg px-2.5 py-1.5 text-left text-xs transition-colors duration-150 ${
      onDark
        ? 'bg-white/15 text-white hover:bg-white/20'
        : 'bg-blue-50 text-text-primary-light hover:bg-blue-100/70 dark:bg-blue-900/30 dark:text-text-primary-dark dark:hover:bg-blue-900/45'
    }`}
  >
    <span className={`block truncate font-semibold ${onDark ? 'text-white' : 'text-blue-700 dark:text-blue-300'}`}>
      {replyTo.senderName}
    </span>
    <span className={`line-clamp-2 whitespace-normal [overflow-wrap:anywhere] ${onDark ? 'text-white/85' : 'text-text-secondary-light dark:text-text-secondary-dark'}`}>
      {replyTo.deleted ? 'Message deleted' : (replyTo.body ?? 'Attachment')}
    </span>
  </button>
);
