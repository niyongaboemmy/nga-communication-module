import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  Paperclip, Smile, AtSign, Send, Mic, Lock, Archive, CloudOff, X, Quote,
  FileText, AlertCircle, Upload, Clock, Slash, CalendarPlus,
} from 'lucide-react';
import { IconButton } from '../../components/ui';
import { usePermissions } from '../../hooks/usePermissions';
import { TYPING_THROTTLE_MS, MAX_MESSAGE_LENGTH } from '@tupo/shared';
import { useNavigate } from 'react-router-dom';
import { useNotify } from '../../context/NotificationContext';
import { useChat } from './ChatProvider';
import { EmojiPicker, rememberEmoji } from './EmojiPicker';
import { useUploads, MAX_ATTACHMENTS } from './useUploads';
import { MentionAutocomplete, findMentionQuery } from './MentionAutocomplete';
import type { MentionQuery } from './MentionAutocomplete';
import * as chatApi from './api';
import type { WireMember } from '@tupo/shared';
import { VoiceRecorder, canRecordVoice } from './VoiceRecorder';
import { formatBytes } from './data';
import { parseSlashCommand, matchCommands } from './slashCommands';
import { SchedulePopover } from './SchedulePopover';
import { MeetSchedulePopover } from './MeetSchedulePopover';
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

export const Composer: React.FC<{
  conversation: Conversation;
  /** Lets a slash command open a side panel, which the layout owns. */
  onOpenPanel?: (panel: 'search' | 'saved' | 'settings' | 'scheduled' | 'shortcuts') => void;
}> = ({ conversation, onOpenPanel }) => {
  const { can } = usePermissions();
  const { notify } = useNotify();
  const navigate = useNavigate();
  const {
    send, notifyTyping, draftFor, setDraft, connected, queued, replyTarget, setReplyTarget,
    enterToSend, lastEditableOwnMessage, setEditingId,
  } = useChat();
  const ref = useRef<HTMLTextAreaElement>(null);

  const value = draftFor(conversation.id);
  const [touch, setTouch] = useState(false);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [recording, setRecording] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [mention, setMention] = useState<MentionQuery | null>(null);
  const [scheduling, setScheduling] = useState(false);
  const [meetOpen, setMeetOpen] = useState(false);
  const [members, setMembers] = useState<WireMember[]>([]);
  const fileInput = useRef<HTMLInputElement>(null);
  const tray = useUploads();

  /*
   * An upload in flight is worth announcing.
   *
   * A large attachment can take a minute, during which the room sees nothing at
   * all — the sender stopped typing to pick the file, so even the typing
   * indicator has expired. This reuses the typing channel (see ActivityKind) to
   * say what is actually happening, refreshed on the same TTL as typing so it
   * disappears on its own if the tab goes away mid-upload.
   */
  const uploading = tray.uploads.some((u) => u.state === 'uploading');
  useEffect(() => {
    if (!uploading) return;
    notifyTyping('uploading');
    const t = setInterval(() => notifyTyping('uploading'), TYPING_THROTTLE_MS);
    return () => clearInterval(t);
  }, [uploading, notifyTyping]);

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

  /*
   * The member list backs the @ picker.
   *
   * Fetched once per conversation rather than per keystroke: a channel's
   * membership does not change while someone is typing a name, and a request
   * per character would be a request per character.
   */
  useEffect(() => {
    if (!can('MESSAGE_SEND')) return;
    let cancelled = false;
    chatApi.listMembers(conversation.id)
      .then((rows) => { if (!cancelled) setMembers(rows); })
      .catch(() => { if (!cancelled) setMembers([]); });
    return () => { cancelled = true; };
  }, [conversation.id, can]);

  /** Re-evaluate whether the caret sits inside an `@…` token. */
  const syncMention = useCallback((text: string, caret: number) => {
    setMention(findMentionQuery(text, caret));
  }, []);

  /** Replace the `@…` token under the caret with the chosen mention. */
  const applyMention = useCallback((replacement: string) => {
    if (!mention) return;
    const el = ref.current;
    const caret = el?.selectionStart ?? value.length;
    const next = value.slice(0, mention.start) + replacement + value.slice(caret);
    setDraft(conversation.id, next);
    setMention(null);
    requestAnimationFrame(() => {
      el?.focus();
      const pos = mention.start + replacement.length;
      el?.setSelectionRange(pos, pos);
    });
  }, [mention, value, conversation.id, setDraft]);

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

    // A slash command is resolved here rather than server-side: most of them
    // open something in this window, and round-tripping "show me my saved
    // items" through the API would be theatre.
    const command = parseSlashCommand(text);
    switch (command.kind) {
      case 'error':
        notify({ title: command.message, tone: 'warning' });
        return;

      case 'open':
        setDraft(conversation.id, '');
        onOpenPanel?.(command.target);
        return;

      case 'meet':
        // Opens the scheduler here rather than navigating to Meet: the whole
        // point of the shortcut is to stay in the conversation the meeting is
        // about.
        setDraft(conversation.id, '');
        setMeetOpen(true);
        return;

      case 'poll':
        setDraft(conversation.id, '');
        void chatApi.createPoll(conversation.id, {
          question: command.question, options: command.options,
        }).catch((err) => notify({
          title: 'The poll could not be created',
          body: err instanceof Error ? err.message : undefined,
          tone: 'error',
        }));
        return;

      case 'me':
        void send({ body: `_${command.body}_`, attachments: tray.readyIds });
        tray.clear();
        return;

      case 'shrug':
        void send({ body: command.body, attachments: tray.readyIds });
        tray.clear();
        return;

      default:
        void send({ body: command.body, attachments: tray.readyIds });
        tray.clear();
    }
  }, [value, send, tray, conversation.id, setDraft, onOpenPanel, notify, navigate]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Escape drops the quote rather than clearing what has been typed —
    // clearing a half-written message with one key is unforgivable.
    if (e.key === 'Escape' && replyTarget) {
      e.preventDefault();
      setReplyTarget(null);
      return;
    }
    /*
     * Enter sends on a pointer device, unless the user has said otherwise.
     *
     * On touch it never sends: there is no Shift key on a phone keyboard, so
     * Enter has to be the only way to start a new line and the button has to be
     * the only way to send.
     */
    /*
     * ↑ on an empty composer edits your last message.
     *
     * Only when empty, and only with the caret at the start — otherwise the key
     * is doing its ordinary job of moving through what someone is writing, and
     * hijacking it would be maddening.
     */
    if (e.key === 'ArrowUp' && !value && !mention) {
      const target = lastEditableOwnMessage();
      if (target) {
        e.preventDefault();
        setEditingId(target.id);
        return;
      }
    }

    if (e.key === 'Enter' && !e.shiftKey && !touch && enterToSend) {
      e.preventDefault();
      submit();
    }
    // With enter-to-send off, ⌘/Ctrl+Enter is still the fast path.
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
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
        className={`relative flex items-end gap-1.5 rounded-2xl border bg-surface-light px-1.5 py-1.5 transition-colors duration-150 focus-within:bg-white focus-within:ring-2 dark:bg-elevated-dark/60 dark:focus-within:bg-elevated-dark ${
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
            <IconButton label="Attach a file" tooltipSide="top" onClick={() => fileInput.current?.click()}>
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
            syncMention(e.target.value, e.target.selectionStart ?? e.target.value.length);
            // Throttled inside the provider — one event per keystroke would be
            // thousands of packets for a fact that is true for six seconds.
            if (e.target.value) notifyTyping();
          }}
          onKeyUp={(e) => {
            // Arrow keys and clicks move the caret without changing the text,
            // and the picker has to follow it out of the token.
            const el = e.currentTarget;
            syncMention(el.value, el.selectionStart ?? el.value.length);
          }}
          onClick={(e) => {
            const el = e.currentTarget;
            syncMention(el.value, el.selectionStart ?? el.value.length);
          }}
          onBlur={() => setMention(null)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          placeholder={
            conversation.type === 'dm'
              ? `Message ${conversation.name.split(' ')[0]}`
              : `Message #${conversation.name}`
          }
          className="max-h-40 min-h-9 flex-1 resize-none bg-transparent px-1 py-2 text-sm leading-relaxed text-text-primary-light outline-none placeholder:text-text-secondary-light/80 dark:text-text-primary-dark dark:placeholder:text-text-secondary-dark/70"
        />

        <IconButton
          label="Mention someone"
          tooltipSide="top"
          className="hidden sm:grid"
          onClick={() => {
            insertAtCaret('@');
            requestAnimationFrame(() => {
              const el = ref.current;
              if (el) syncMention(el.value, el.selectionStart ?? el.value.length);
            });
          }}
        >
          <AtSign size={18} />
        </IconButton>
        <div className="relative">
          <IconButton
            label="Insert emoji"
            tooltipSide="top"
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

        {/* The slash hint list. Shown only while the whole message is still
            just "/word" — once there are arguments, the list is in the way. */}
        {matchCommands(value).length > 0 && (
          <div className="absolute bottom-full left-0 z-50 mb-2 w-72 overflow-hidden rounded-2xl border border-border-light bg-white py-1 shadow-2xl dark:border-border-dark/50 dark:bg-elevated-dark">
            {matchCommands(value).map((c) => (
              <button
                key={c.name}
                onMouseDown={(e) => {
                  e.preventDefault();
                  setDraft(conversation.id, `/${c.name} `);
                  ref.current?.focus();
                }}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-surface-light dark:hover:bg-surface-dark"
              >
                <Slash size={11} className="shrink-0 opacity-50" />
                <span className="min-w-0 flex-1">
                  <span className="block text-xs font-medium text-text-primary-light dark:text-text-primary-dark">
                    /{c.name} {c.args && <span className="font-normal opacity-60">{c.args}</span>}
                  </span>
                  <span className="block truncate text-[11px] text-text-secondary-light dark:text-text-secondary-dark">
                    {c.hint}
                  </span>
                </span>
              </button>
            ))}
          </div>
        )}

        {mention && (
          <MentionAutocomplete
            members={members}
            query={mention}
            onPick={applyMention}
            onDismiss={() => setMention(null)}
            allowBroadcast={conversation.type !== 'dm'}
          />
        )}

        {/* Send swaps to a mic when there is nothing to send — the button slot
            never sits there disabled and dead. */}
        {(can('MEET_START') || can('MEET_SCHEDULE')) && (
          <div className="relative">
            <IconButton
              label="Start or schedule a meeting"
              tooltipSide="top"
              active={meetOpen}
              onClick={() => setMeetOpen((v) => !v)}
            >
              <CalendarPlus size={18} />
            </IconButton>
            {meetOpen && (
              <MeetSchedulePopover
                conversation={conversation}
                onClose={() => setMeetOpen(false)}
                onAnnounce={({ body, metadata }) =>
                  send({ body, type: 'call_event', metadata })}
              />
            )}
          </div>
        )}

        {/* Schedule sits beside send rather than inside a menu: "send this
            later" is a decision made at the moment of sending. */}
        {can('MESSAGE_SCHEDULE') && value.trim() && (
          <div className="relative">
            <IconButton label="Schedule this message" tooltipSide="top" onClick={() => setScheduling(true)}>
              <Clock size={18} />
            </IconButton>
            {scheduling && (
              <SchedulePopover
                conversationId={conversation.id}
                body={value.trim()}
                onDone={() => { setScheduling(false); setDraft(conversation.id, ''); }}
                onClose={() => setScheduling(false)}
              />
            )}
          </div>
        )}

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
          <IconButton label="Record a voice message" tooltipSide="top" onClick={() => setRecording(true)}>
            <Mic size={18} />
          </IconButton>
        ) : null}
      </div>

      <div className="mt-1 flex items-center justify-between gap-2 px-2">
        <p className={`hidden text-[11px] text-text-secondary-light/80 dark:text-text-secondary-dark/70 ${value.trim() ? 'md:block' : ''}`}>
          {enterToSend ? (
            <>
              <kbd className="font-sans font-semibold">Enter</kbd> to send ·{' '}
              <kbd className="font-sans font-semibold">Shift + Enter</kbd> for a new line
            </>
          ) : (
            <>
              <kbd className="font-sans font-semibold">⌘/Ctrl + Enter</kbd> to send ·{' '}
              <kbd className="font-sans font-semibold">Enter</kbd> for a new line
            </>
          )}
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
