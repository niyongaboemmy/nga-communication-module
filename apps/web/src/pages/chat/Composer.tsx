import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  Paperclip, Smile, AtSign, Send, Mic, Lock, Archive, CloudOff, X, Quote,
  FileText, AlertCircle, Upload,
} from 'lucide-react';
import { IconButton } from '../../components/ui';
import { usePermissions } from '../../hooks/usePermissions';
import { MAX_MESSAGE_LENGTH } from '@tupo/shared';
import { useChat } from './ChatProvider';
import { EmojiPicker, rememberEmoji } from './EmojiPicker';
import { useUploads, MAX_ATTACHMENTS } from './useUploads';
import { VoiceRecorder, canRecordVoice } from './VoiceRecorder';
import { formatBytes } from './data';
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
  const {
    send, notifyTyping, draftFor, setDraft, connected, queued, replyTarget, setReplyTarget,
  } = useChat();
  const ref = useRef<HTMLTextAreaElement>(null);

  const value = draftFor(conversation.id);
  const [touch, setTouch] = useState(false);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [recording, setRecording] = useState(false);
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const tray = useUploads();

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

  /**
   * Insert at the caret, not at the end.
   *
   * Someone who has clicked back into the middle of a sentence to add an emoji
   * means it to go there. Appending is the behaviour that makes people stop
   * using the picker.
   */
  const insertAtCaret = useCallback((text: string) => {
    const el = ref.current;
    const current = value;
    const start = el?.selectionStart ?? current.length;
    const end = el?.selectionEnd ?? current.length;
    const next = current.slice(0, start) + text + current.slice(end);
    setDraft(conversation.id, next);
    requestAnimationFrame(() => {
      el?.focus();
      const caret = start + text.length;
      el?.setSelectionRange(caret, caret);
    });
  }, [value, conversation.id, setDraft]);

  const submit = useCallback(() => {
    const text = value.trim();
    // An attachment on its own is a message. Requiring a caption for a photo
    // is a rule no chat product has ever had.
    if (!text && tray.readyIds.length === 0) return;
    // Uploads still in flight are waited for rather than dropped — pressing
    // Send with a half-uploaded photo must not post the sentence without it.
    if (tray.busy) return;

    void send({ body: text, attachments: tray.readyIds });
    tray.clear();
  }, [value, send, tray]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Escape drops the quote rather than clearing what has been typed —
    // clearing a half-written message with one key is unforgivable.
    if (e.key === 'Escape' && replyTarget) {
      e.preventDefault();
      setReplyTarget(null);
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey && !touch) {
      e.preventDefault();
      submit();
    }
  };

  // Choosing a message to answer is choosing to write; put the caret there.
  useEffect(() => {
    if (replyTarget && !touch) ref.current?.focus();
  }, [replyTarget, touch]);

  /*
   * Paste an image straight in.
   *
   * Screenshots are the single most common attachment in a working chat, and
   * the clipboard is where they land. Requiring someone to save a screenshot to
   * disk before they can share it is a step that exists only because the app
   * did not handle the paste.
   */
  const onPaste = (e: React.ClipboardEvent) => {
    const files = Array.from(e.clipboardData?.files ?? []);
    if (!files.length) return;
    e.preventDefault();
    tray.add(files);
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
    <div
      className="pb-safe relative shrink-0 border-t border-border-light bg-white px-2 py-2.5 sm:px-4 dark:border-border-dark/30 dark:bg-chrome-dark"
      onDragOver={(e) => {
        if (!can('FILE_UPLOAD') || !e.dataTransfer.types.includes('Files')) return;
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(e) => {
        // Only when the pointer actually leaves the composer, not when it
        // crosses into a child — otherwise the overlay flickers constantly.
        if (e.currentTarget.contains(e.relatedTarget as Node)) return;
        setDragging(false);
      }}
      onDrop={(e) => {
        if (!can('FILE_UPLOAD')) return;
        e.preventDefault();
        setDragging(false);
        if (e.dataTransfer.files?.length) tray.add(e.dataTransfer.files);
      }}
    >
      {dragging && (
        <div className="pointer-events-none absolute inset-1 z-20 grid place-items-center rounded-2xl border-2 border-dashed border-blue-500 bg-blue-50/90 dark:bg-blue-900/40">
          <p className="flex items-center gap-2 text-sm font-medium text-blue-700 dark:text-blue-300">
            <Upload size={16} /> Drop to attach
          </p>
        </div>
      )}

      {/* Upload problems are stated here, next to the thing that caused them,
          rather than in a toast that has scrolled away by the time it is read. */}
      {tray.errors.map((message, i) => (
        <div
          key={i}
          className="mb-1.5 flex items-center gap-2 rounded-lg bg-red-50 px-2.5 py-1.5 text-xs text-red-700 dark:bg-red-500/10 dark:text-red-300"
        >
          <AlertCircle size={13} className="shrink-0" />
          <span className="flex-1">{message}</span>
          <IconButton label="Dismiss" size="sm" onClick={() => tray.dismissError(i)}>
            <X size={12} />
          </IconButton>
        </div>
      ))}

      {tray.uploads.length > 0 && (
        <ul className="mb-1.5 flex flex-wrap gap-2" aria-label="Attachments">
          {tray.uploads.map((u) => (
            <li
              key={u.localId}
              className="group relative flex items-center gap-2 rounded-xl border border-border-light bg-surface-light p-1.5 pr-2 dark:border-border-dark/50 dark:bg-elevated-dark/60"
            >
              {u.previewUrl && u.kind === 'image' ? (
                <img src={u.previewUrl} alt="" className="h-10 w-10 rounded-lg object-cover" />
              ) : (
                <span className="grid h-10 w-10 place-items-center rounded-lg bg-slate-200 text-slate-500 dark:bg-slate-700 dark:text-slate-300">
                  {u.kind === 'audio' ? <Mic size={16} /> : <FileText size={16} />}
                </span>
              )}

              <span className="min-w-0 max-w-[9rem]">
                <span className="block truncate text-[11px] font-medium text-text-primary-light dark:text-text-primary-dark">
                  {u.name}
                </span>
                <span className="block text-[10px] text-text-secondary-light dark:text-text-secondary-dark">
                  {u.state === 'failed'
                    ? <span className="text-red-600 dark:text-red-400">Failed</span>
                    : u.state === 'ready'
                      ? formatBytes(u.size)
                      : `${Math.round(u.progress * 100)}%`}
                </span>
                {u.state !== 'ready' && u.state !== 'failed' && (
                  <span className="mt-1 block h-0.5 w-full overflow-hidden rounded-full bg-slate-300 dark:bg-slate-600">
                    <span
                      className="block h-full rounded-full bg-blue-600 transition-[width] duration-150"
                      style={{ width: `${Math.round(u.progress * 100)}%` }}
                    />
                  </span>
                )}
              </span>

              <IconButton
                label={u.state === 'uploading' ? `Cancel ${u.name}` : `Remove ${u.name}`}
                size="sm"
                onClick={() => tray.remove(u.localId)}
              >
                <X size={13} />
              </IconButton>
            </li>
          ))}
        </ul>
      )}

      {recording && (
        <div className="mb-1.5">
          <VoiceRecorder
            onCancel={() => setRecording(false)}
            onDone={({ file, durationMs, waveform }) => {
              setRecording(false);
              // Straight into the tray, where it uploads like any attachment —
              // and is still cancellable before it is sent. The waveform comes
              // from the live analyser and cannot be recovered from the blob.
              tray.add([file], { durationMs, waveform });
            }}
          />
        </div>
      )}

      {/* FR-MSG-7: what you are answering, above what you are writing. */}
      {replyTarget && (
        <div className="mb-1.5 flex items-start gap-2 rounded-xl border-l-2 border-blue-500 bg-surface-light px-2.5 py-1.5 dark:bg-elevated-dark/60">
          <Quote size={13} className="mt-0.5 shrink-0 text-blue-500" />
          <div className="min-w-0 flex-1">
            <p className="text-[11px] font-semibold text-text-primary-light dark:text-text-primary-dark">
              Replying to {replyTarget.senderName}
            </p>
            <p className="truncate text-xs text-text-secondary-light dark:text-text-secondary-dark">
              {replyTarget.body ?? 'Attachment'}
            </p>
          </div>
          <IconButton label="Cancel reply" size="sm" onClick={() => setReplyTarget(null)}>
            <X size={14} />
          </IconButton>
        </div>
      )}

      <div
        className={`flex items-end gap-1.5 rounded-2xl border bg-surface-light px-1.5 py-1.5 transition-colors duration-150 focus-within:bg-white focus-within:ring-2 dark:bg-elevated-dark/60 dark:focus-within:bg-elevated-dark ${
          over
            ? 'border-red-400 focus-within:border-red-500 focus-within:ring-red-500/20'
            : 'border-border-light focus-within:border-blue-500 focus-within:ring-blue-500/20 dark:border-border-dark/50'
        }`}
      >
        {can('FILE_UPLOAD') && (
          <>
            <input
              ref={fileInput}
              type="file"
              multiple
              className="sr-only"
              onChange={(e) => {
                if (e.target.files) tray.add(e.target.files);
                // Reset, or choosing the same file twice in a row does nothing.
                e.target.value = '';
              }}
            />
            <IconButton label="Attach a file" onClick={() => fileInput.current?.click()}>
              <Paperclip size={18} />
            </IconButton>
          </>
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
          onPaste={onPaste}
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
        <div className="relative">
          <IconButton
            label="Insert emoji"
            active={emojiOpen}
            onClick={() => setEmojiOpen((v) => !v)}
          >
            <Smile size={18} />
          </IconButton>
          {emojiOpen && (
            <EmojiPicker
              align="up"
              onPick={(e) => { rememberEmoji(e); insertAtCaret(e); setEmojiOpen(false); }}
              onClose={() => setEmojiOpen(false)}
            />
          )}
        </div>

        {/* Send swaps to a mic when there is nothing to send — the button slot
            never sits there disabled and dead. */}
        {value.trim() || tray.uploads.length > 0 ? (
          <button
            onClick={submit}
            disabled={over || tray.busy}
            aria-label={tray.busy ? 'Waiting for attachments to finish uploading' : 'Send message'}
            title={tray.busy ? 'Waiting for attachments' : undefined}
            className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-blue-600 text-white transition-colors duration-150 hover:bg-blue-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Send size={17} />
          </button>
        ) : canRecordVoice() && can('FILE_UPLOAD') ? (
          <IconButton label="Record a voice message" onClick={() => setRecording(true)}>
            <Mic size={18} />
          </IconButton>
        ) : null}
      </div>

      <div className="mt-1 flex items-center justify-between gap-2 px-2">
        <p className="hidden text-[11px] text-text-secondary-light/80 md:block dark:text-text-secondary-dark/70">
          <kbd className="font-sans font-semibold">Enter</kbd> to send ·{' '}
          <kbd className="font-sans font-semibold">Shift + Enter</kbd> for a new line
        </p>
        {/* Offline is stated plainly, with the promise the outbox actually
            keeps: it will go, in order, when the connection returns. Saying
            nothing here is what makes people retype a message they already
            sent. */}
        {!connected && (
          <p className="flex items-center gap-1 text-[11px] font-medium text-amber-600 dark:text-amber-400">
            <CloudOff size={11} />
            {queued > 0
              ? `Offline — ${queued} message${queued > 1 ? 's' : ''} will send when you reconnect`
              : 'Offline — messages will send when you reconnect'}
          </p>
        )}

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
