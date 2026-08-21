import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Paperclip, Smile, AtSign, Send, Mic, Lock, Archive } from 'lucide-react';
import { IconButton } from '../../components/ui';
import { usePermissions } from '../../hooks/usePermissions';
import { MAX_MESSAGE_LENGTH } from '@tupo/shared';
import { useChat } from './ChatProvider';
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
  const { send, notifyTyping, draftFor, setDraft } = useChat();
  const ref = useRef<HTMLTextAreaElement>(null);

  const value = draftFor(conversation.id);
  const [touch, setTouch] = useState(false);

  useEffect(() => {
    setTouch(window.matchMedia('(pointer: coarse)').matches);
  }, []);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, MAX_ROWS_PX)}px`;
  }, [value]);

  // Focus follows the open conversation on a pointer device, so switching
  // channels and typing works without a click. Not on touch: focusing there
  // throws up the on-screen keyboard and hides the messages the user came for.
  useEffect(() => {
    if (!touch) ref.current?.focus();
  }, [conversation.id, touch]);

  const canPost = can('MESSAGE_SEND')
    && (conversation.type !== 'announcement'
        || can('CHANNEL_ANNOUNCE')
        || conversation.myRole === 'owner'
        || conversation.myRole === 'admin');

  const submit = useCallback(() => {
    const text = value.trim();
    if (!text) return;
    void send({ body: text });
  }, [value, send]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !touch) {
      e.preventDefault();
      submit();
    }
  };

  // An archived conversation is read-only for everyone, whatever their role.
  if (conversation.isArchived) {
    return (
      <div className="pb-safe shrink-0 border-t border-border-light bg-white px-4 py-3 dark:border-border-dark/30 dark:bg-chrome-dark">
        <p className="flex items-center justify-center gap-2 text-xs text-text-secondary-light dark:text-text-secondary-dark">
          <Archive size={13} />
          This conversation is archived. You can read it, but not post.
        </p>
      </div>
    );
  }

  // Announcement channels are read-only for most members by design. Saying so
  // is better UX than showing a composer whose send button always 403s.
  if (!canPost) {
    return (
      <div className="pb-safe shrink-0 border-t border-border-light bg-white px-4 py-3 dark:border-border-dark/30 dark:bg-chrome-dark">
        <p className="flex items-center justify-center gap-2 text-xs text-text-secondary-light dark:text-text-secondary-dark">
          <Lock size={13} />
          {conversation.type === 'announcement'
            ? 'Only channel announcers can post here.'
            : 'You do not have permission to send messages.'}
        </p>
      </div>
    );
  }

  const over = value.length > MAX_MESSAGE_LENGTH;
  const nearLimit = value.length > MAX_MESSAGE_LENGTH * 0.9;

  return (
    <div className="pb-safe shrink-0 border-t border-border-light bg-white px-2 py-2.5 sm:px-4 dark:border-border-dark/30 dark:bg-chrome-dark">
      <div
        className={`flex items-end gap-1.5 rounded-2xl border bg-surface-light px-1.5 py-1.5 transition-colors duration-150 focus-within:bg-white focus-within:ring-2 dark:bg-elevated-dark/60 dark:focus-within:bg-elevated-dark ${
          over
            ? 'border-red-400 focus-within:border-red-500 focus-within:ring-red-500/20'
            : 'border-border-light focus-within:border-blue-500 focus-within:ring-blue-500/20 dark:border-border-dark/50'
        }`}
      >
        {can('FILE_UPLOAD') && (
          <IconButton label="Attach a file">
            <Paperclip size={18} />
          </IconButton>
        )}

        <label className="sr-only" htmlFor="composer">
          Message {conversation.name}
        </label>
        <textarea
          id="composer"
          ref={ref}
          rows={1}
          value={value}
          onChange={(e) => {
            setDraft(conversation.id, e.target.value);
            // Throttled inside the provider — one event per keystroke would be
            // thousands of packets for a fact that is true for six seconds.
            if (e.target.value) notifyTyping();
          }}
          onKeyDown={onKeyDown}
          placeholder={
            conversation.type === 'dm'
              ? `Message ${conversation.name.split(' ')[0]}`
              : `Message #${conversation.name}`
          }
          className="max-h-40 min-h-9 flex-1 resize-none bg-transparent px-1 py-2 text-sm leading-relaxed text-text-primary-light outline-none placeholder:text-text-secondary-light/80 dark:text-text-primary-dark dark:placeholder:text-text-secondary-dark/70"
        />

        <IconButton label="Mention someone" className="hidden sm:grid">
          <AtSign size={18} />
        </IconButton>
        <IconButton label="Insert emoji">
          <Smile size={18} />
        </IconButton>

        {/* Send swaps to a mic when there is nothing to send — the button slot
            never sits there disabled and dead. */}
        {value.trim() ? (
          <button
            onClick={submit}
            disabled={over}
            aria-label="Send message"
            className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-blue-600 text-white transition-colors duration-150 hover:bg-blue-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Send size={17} />
          </button>
        ) : (
          <IconButton label="Record a voice message">
            <Mic size={18} />
          </IconButton>
        )}
      </div>

      <div className="mt-1 flex items-center justify-between gap-2 px-2">
        <p className="hidden text-[11px] text-text-secondary-light/80 md:block dark:text-text-secondary-dark/70">
          <kbd className="font-sans font-semibold">Enter</kbd> to send ·{' '}
          <kbd className="font-sans font-semibold">Shift + Enter</kbd> for a new line
        </p>
        {/* The counter appears only when it is about to matter. A permanent
            character count on every chat box is noise. */}
        {nearLimit && (
          <p className={`text-[11px] tabular-nums ${over ? 'font-semibold text-red-500' : 'text-text-secondary-light dark:text-text-secondary-dark'}`}>
            {value.length.toLocaleString()} / {MAX_MESSAGE_LENGTH.toLocaleString()}
          </p>
        )}
      </div>
    </div>
  );
};
