import React, { useLayoutEffect, useRef, useState } from 'react';
import { Paperclip, Smile, AtSign, Send, Mic, Lock } from 'lucide-react';
import { IconButton } from '../../components/ui';
import { usePermissions } from '../../hooks/usePermissions';
import type { Conversation } from './types';

/**
 * The composer.
 *
 * `pb-safe` and the shell's `100dvh` are what keep it docked above the on-screen
 * keyboard on iOS rather than sliding under the home indicator (§15.1, mobile).
 *
 * The textarea grows with its content up to ~6 lines and then scrolls; growing
 * without a ceiling would eventually eat the whole message list on a phone.
 *
 * Enter sends and Shift+Enter inserts a newline on a pointer device. On touch,
 * Enter always inserts a newline — there is no Shift key on a phone keyboard, so
 * send has to be the button.
 */

const MAX_ROWS_PX = 160;

export const Composer: React.FC<{ conversation: Conversation }> = ({ conversation }) => {
  const { can } = usePermissions();
  const [value, setValue] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, MAX_ROWS_PX)}px`;
  }, [value]);

  const canSend =
    can('MESSAGE_SEND') &&
    (conversation.kind !== 'announcement' || can('CHANNEL_ANNOUNCE'));

  // Announcement channels are read-only for most members by design. Saying so
  // is better UX than showing a composer whose send button always 403s.
  if (!canSend) {
    return (
      <div className="pb-safe shrink-0 border-t border-border-light bg-white px-4 py-3 dark:border-gray-700/30 dark:bg-gray-800/40">
        <p className="flex items-center justify-center gap-2 text-xs text-text-secondary-light dark:text-text-secondary-dark">
          <Lock size={13} />
          {conversation.kind === 'announcement'
            ? 'Only channel announcers can post here.'
            : 'You do not have permission to send messages.'}
        </p>
      </div>
    );
  }

  const send = () => {
    if (!value.trim()) return;
    // Phase 1 wires this to the optimistic-send path (UX-1): append locally as
    // `pending`, emit over the socket, reconcile on ack.
    setValue('');
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const touch = window.matchMedia('(pointer: coarse)').matches;
    if (e.key === 'Enter' && !e.shiftKey && !touch) {
      e.preventDefault();
      send();
    }
  };

  return (
    <div className="pb-safe shrink-0 border-t border-border-light bg-white px-2 py-2.5 sm:px-4 dark:border-gray-700/30 dark:bg-gray-800/40">
      <div className="flex items-end gap-1.5 rounded-2xl border border-border-light bg-surface-light px-1.5 py-1.5 transition-colors duration-150 focus-within:border-blue-500 focus-within:bg-white focus-within:ring-2 focus-within:ring-blue-500/20 dark:border-gray-700/50 dark:bg-gray-800/70 dark:focus-within:bg-gray-800">
        {can('FILE_UPLOAD') && (
          <IconButton label="Attach a file"><Paperclip size={18} /></IconButton>
        )}

        <label className="sr-only" htmlFor="composer">
          Message {conversation.name}
        </label>
        <textarea
          id="composer"
          ref={ref}
          rows={1}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={
            conversation.kind === 'dm'
              ? `Message ${conversation.name.split(' ')[0]}`
              : `Message #${conversation.name}`
          }
          className="max-h-40 min-h-9 flex-1 resize-none bg-transparent px-1 py-2 text-sm leading-relaxed text-text-primary-light outline-none placeholder:text-text-secondary-light/80 dark:text-text-primary-dark dark:placeholder:text-text-secondary-dark/70"
        />

        <IconButton label="Mention someone" className="hidden sm:grid"><AtSign size={18} /></IconButton>
        <IconButton label="Insert emoji"><Smile size={18} /></IconButton>

        {/* Send swaps to a mic when there is nothing to send — the button slot
            never sits there disabled and dead. */}
        {value.trim() ? (
          <button
            onClick={send}
            aria-label="Send message"
            className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-blue-600 text-white shadow-sm shadow-blue-600/25 transition-colors duration-150 hover:bg-blue-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
          >
            <Send size={17} />
          </button>
        ) : (
          <IconButton label="Record a voice message"><Mic size={18} /></IconButton>
        )}
      </div>

      <p className="mt-1 hidden px-2 text-[11px] text-text-secondary-light/80 md:block dark:text-text-secondary-dark/70">
        <kbd className="font-sans font-semibold">Enter</kbd> to send ·{' '}
        <kbd className="font-sans font-semibold">Shift + Enter</kbd> for a new line
      </p>
    </div>
  );
};
