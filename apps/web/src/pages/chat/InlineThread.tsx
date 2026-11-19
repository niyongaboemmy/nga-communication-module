import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Maximize2, Send } from 'lucide-react';
import type { WireMessage } from '@tupo/shared';
import { MAX_MESSAGE_LENGTH } from '@tupo/shared';
import { Skeleton } from '../../components/ui';
import { useAuth } from '../../context/AuthContext';
import { useNotify } from '../../context/NotificationContext';
import { useChatActions } from './ChatProvider';
import { MessageRow } from './MessageRow';
import { threadKey, drafts } from './drafts';
import { useComposerBox } from './useComposerBox';
import { toWire, type MentionTarget } from './mentionText';
import * as chatApi from './api';

/**
 * A thread's replies, under its root, in the channel (R-03) — the Facebook
 * pattern. The latest three show first; "View N earlier replies" pages back
 * ten at a time, up to 20 in place, after which "Open thread" is the way to
 * read the rest (the side pane, full screen on a phone). Collapsed is the
 * default everywhere except where the reader has unread replies, so a busy
 * class channel stays readable — the reason threads moved to a pane at all.
 *
 * Replies render as compact message rows with every action, and arrive live:
 * the provider forwards sends, arrivals, edits, deletions and reactions for
 * this root. Replying to a reply stays in this thread and starts with
 * "@Name " (one level deep, never nested further).
 */

const FIRST = 3;
const PAGE = 10;
const INLINE_MAX = 20;

const firstName = (n: string) => n.split(' ')[0] || n;

export const InlineThread: React.FC<{
  root: WireMessage;
  canReply: boolean;
  /** "Didier is replying…" — people typing in this thread right now. */
  replying?: string;
  names: Record<string, string>;
  /** Increments when the person pressed Reply on the root: focus the box. */
  focusRequest: number;
}> = ({ root, canReply, names, focusRequest, replying }) => {
  const { user } = useAuth();
  const { notify } = useNotify();
  const { subscribeThread, sendThreadReply, openThread, markThreadRead, notifyTyping, stopTyping } = useChatActions();
  const [replies, setReplies] = useState<WireMessage[]>([]);
  const [hasEarlier, setHasEarlier] = useState(false);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const picked = useRef<MentionTarget[]>([]);

  const withoutRoot = useCallback((list: WireMessage[]) => list.filter((m) => m.id !== root.id), [root.id]);

  const load = useCallback(() => {
    setLoading(true);
    setFailed(false);
    chatApi.listMessages(root.conversationId, { thread: root.id, limit: FIRST })
      .then((page) => {
        const list = withoutRoot(page.messages);
        setReplies(list);
        setHasEarlier(page.hasMore && list.length > 0);
      })
      .catch(() => setFailed(true))
      .finally(() => setLoading(false));
  }, [root.conversationId, root.id, withoutRoot]);

  useEffect(() => { load(); }, [load]);

  // Live: sends from here, arrivals, edits, deletions, reactions.
  useEffect(() => subscribeThread(root.id, (fn) => setReplies((prev) => withoutRoot(fn(prev)))),
    [root.id, subscribeThread, withoutRoot]);

  /*
   * Read means seen: the replies count as read only while this block is on
   * screen with the tab visible — the same honest proxy the main log uses —
   * not merely because it is expanded somewhere up the log.
   */
  const boxRef = useRef<HTMLDivElement>(null);
  const [onScreen, setOnScreen] = useState(false);
  useEffect(() => {
    const el = boxRef.current;
    if (!el || typeof IntersectionObserver === 'undefined') { setOnScreen(true); return; }
    const io = new IntersectionObserver(([e]) => setOnScreen(Boolean(e?.isIntersecting)), { threshold: 0.5 });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  const newest = replies.reduce((max, m) => (m.seq !== Number.MAX_SAFE_INTEGER && m.seq > max ? m.seq : max), 0);
  useEffect(() => {
    if (!onScreen || newest <= 0) return;
    const mark = () => { if (!document.hidden) markThreadRead(root.id, newest); };
    mark();
    document.addEventListener('visibilitychange', mark);
    return () => document.removeEventListener('visibilitychange', mark);
  }, [onScreen, newest, root.id, markThreadRead]);

  const loadEarlier = async () => {
    const oldest = replies.find((m) => m.seq > 0 && m.seq !== Number.MAX_SAFE_INTEGER);
    if (!oldest) return;
    setLoadingEarlier(true);
    try {
      const page = await chatApi.listMessages(root.conversationId, { thread: root.id, before: oldest.seq, limit: PAGE });
      const older = withoutRoot(page.messages);
      setReplies((prev) => [...older.filter((o) => !prev.some((p) => p.id === o.id)), ...prev]);
      setHasEarlier(page.hasMore && older.length > 0);
    } catch {
      notify({ title: 'Earlier replies could not be loaded', body: 'Check your connection and try again.', tone: 'error' });
    } finally {
      setLoadingEarlier(false);
    }
  };

  const submitRef = useRef<() => void>(() => {});
  const box = useComposerBox({
    draftKey: threadKey(root.id),
    maxHeightPx: 120,
    onSubmit: () => submitRef.current(),
    onTyping: () => notifyTyping('typing', root.id),
    onTypingStop: stopTyping,
  });
  submitRef.current = () => {
    const raw = box.value.trim();
    if (!raw) return;
    if (raw.length > MAX_MESSAGE_LENGTH) {
      notify({ title: `Messages can be up to ${MAX_MESSAGE_LENGTH.toLocaleString()} characters`, tone: 'warning' });
      return;
    }
    box.takeForSend();
    const body = toWire(raw, picked.current);
    picked.current = [];
    void sendThreadReply(body, false, [], root.id);
  };

  // Reply on the root: put the caret here.
  useEffect(() => {
    if (focusRequest > 0) requestAnimationFrame(() => box.ref.current?.focus());
  }, [focusRequest, box.ref]);

  /** Reply to a reply: same thread, starting "@Name ". */
  const replyTo = useCallback((m: WireMessage) => {
    const key = threadKey(root.id);
    const name = m.senderName;
    if (m.senderId !== user?.id) {
      picked.current = [{ id: m.senderId, name }, ...picked.current.filter((t) => t.id !== m.senderId)];
      const current = drafts.get(key);
      if (!current.startsWith(`@${name}`)) drafts.set(key, `@${name} ${current}`);
    }
    requestAnimationFrame(() => {
      const el = box.ref.current;
      el?.focus();
      el?.setSelectionRange(el.value.length, el.value.length);
    });
  }, [root.id, user?.id, box.ref]);

  const earlierCount = Math.max(0, root.replyCount - replies.filter((m) => m.seq !== Number.MAX_SAFE_INTEGER).length);
  const capped = replies.length >= INLINE_MAX;

  return (
    <div ref={boxRef} data-inline-thread="" className="mt-1.5 w-full min-w-0 rounded-2xl bg-white/70 p-1.5 sm:p-2 dark:bg-elevated-dark/40">
      {loading ? (
        <div className="space-y-2 p-1" aria-busy="true" aria-label="Loading replies">
          <Skeleton className="h-8 w-4/5 rounded-xl" />
          <Skeleton className="h-8 w-3/5 rounded-xl" />
        </div>
      ) : failed ? (
        <p className="flex items-center gap-2 px-2 py-1.5 text-xs text-text-secondary-light dark:text-text-secondary-dark">
          Replies could not be loaded.
          <button onClick={load} className="font-semibold text-blue-600 hover:underline dark:text-blue-400">Try again</button>
        </p>
      ) : (
        <>
          {(hasEarlier || earlierCount > 0) && !capped && (
            <button
              onClick={() => void loadEarlier()}
              disabled={loadingEarlier}
              className="mb-1 min-h-8 rounded-lg px-2 text-xs font-semibold text-blue-700 hover:bg-blue-50 disabled:opacity-60 dark:text-blue-300 dark:hover:bg-blue-900/25"
            >
              {loadingEarlier ? 'Loading…' : `View ${earlierCount > 0 ? earlierCount : ''} earlier ${earlierCount === 1 ? 'reply' : 'replies'}`.replace('  ', ' ')}
            </button>
          )}
          {capped && (hasEarlier || earlierCount > 0) && (
            <button
              onClick={() => openThread(root.id)}
              className="mb-1 min-h-8 rounded-lg px-2 text-xs font-semibold text-blue-700 hover:bg-blue-50 dark:text-blue-300 dark:hover:bg-blue-900/25"
            >
              Open the thread to see all {root.replyCount} replies
            </button>
          )}
          <ul role="log" aria-label={`Replies to ${root.senderName}`} aria-relevant="additions" className="space-y-0.5">
            {replies.map((m) => (
              <MessageRow
                key={m.nonce ?? m.id}
                message={m}
                newGroup
                names={names}
                variant="compact"
                onReply={replyTo}
              />
            ))}
          </ul>
        </>
      )}

      {replying && (
        <p role="status" className="px-2 pt-1 text-[11px] italic text-text-secondary-light dark:text-text-secondary-dark">{replying}</p>
      )}
      <div className="mt-1.5 flex items-end gap-1.5">
        {canReply ? (
          <div className="flex min-w-0 flex-1 items-end gap-1 rounded-xl border border-border-light bg-white px-2 py-1 focus-within:border-blue-500 focus-within:ring-2 focus-within:ring-blue-500/20 dark:border-border-dark/50 dark:bg-elevated-dark">
            <label className="sr-only" htmlFor={`inline-reply-${root.id}`}>Reply to {root.senderName}</label>
            <textarea
              id={`inline-reply-${root.id}`}
              data-inline-composer=""
              {...box.textareaProps}
              rows={1}
              onKeyDown={(e) => { box.handleSubmitKey(e); }}
              placeholder={`Reply to ${firstName(root.senderName)}…`}
              className="max-h-[120px] min-h-8 flex-1 resize-none bg-transparent px-1 py-1.5 text-sm text-text-primary-light outline-none placeholder:text-text-secondary-light/80 dark:text-text-primary-dark"
            />
            <button
              onClick={() => submitRef.current()}
              disabled={!box.value.trim() || box.value.length > MAX_MESSAGE_LENGTH}
              aria-label="Send reply"
              className="mb-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-blue-600 text-white transition-colors duration-150 hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Send size={14} />
            </button>
          </div>
        ) : <span className="flex-1" />}
        <button
          data-thread-open=""
          onClick={() => openThread(root.id)}
          aria-label="Open thread"
          title="Open thread (attachments, everything)"
          className="grid h-10 w-10 shrink-0 place-items-center rounded-xl text-text-secondary-light hover:bg-surface-light hover:text-blue-600 dark:text-text-secondary-dark dark:hover:bg-surface-dark"
        >
          <Maximize2 size={15} />
        </button>
      </div>
    </div>
  );
};
