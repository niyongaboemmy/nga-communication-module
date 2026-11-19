import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, Copy, ExternalLink, Loader2, Search, Send, Share2, X } from 'lucide-react';
import { Link } from 'react-router-dom';
import type { FeedPostView } from '@tupo/shared';
import { useNotify } from '../../context/NotificationContext';
import { useChat } from '../chat/ChatProvider';
import { ConversationAvatar } from '../chat/ConversationAvatar';
import * as chatApi from '../chat/api';
import * as api from './api';

/**
 * Share a post (F-07): four ways out, each one saying what happened.
 *
 *  - Send in chat: pick any conversation; it receives a `post_share` message,
 *    which chat draws as a card of the post. The card fetches the post with
 *    the reader's own rights, so someone who cannot see it sees nothing of it.
 *  - Copy link: and when the browser refuses the clipboard, the link is shown
 *    selected so it can still be copied by hand.
 *  - Share via…: the device's own share sheet, where there is one.
 *  - Open post: its permalink.
 *
 * The post's share count moves once per share, whichever way it went.
 */
export const ShareSheet: React.FC<{ post: FeedPostView; onClose: () => void }> = ({ post, onClose }) => {
  const { notify } = useNotify();
  const { conversations } = useChat();
  const url = `${location.origin}/app/feed/post/${post.id}`;
  const [query, setQuery] = useState('');
  const [sending, setSending] = useState<string | null>(null);
  const [sent, setSent] = useState<Set<string>>(() => new Set());
  const [copied, setCopied] = useState(false);
  const [manualCopy, setManualCopy] = useState(false);
  const counted = useRef(false);
  const linkRef = useRef<HTMLInputElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const countShare = () => {
    if (counted.current) return;
    counted.current = true;
    void api.sharePost(post.id).catch(() => {});
  };

  useEffect(() => {
    searchRef.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const targets = useMemo(() => {
    const q = query.trim().toLowerCase();
    return conversations
      .filter((c) => !c.isArchived)
      .filter((c) => !q || c.name.toLowerCase().includes(q))
      .slice(0, 30);
  }, [conversations, query]);

  const sendTo = async (conversationId: string) => {
    if (sending || sent.has(conversationId)) return;
    setSending(conversationId);
    try {
      await chatApi.sendMessage(conversationId, {
        body: `${post.page.name}: ${url}`,
        nonce: `share-${post.id}-${conversationId}-${Date.now()}`,
        type: 'post_share',
        metadata: { postId: post.id },
      });
      setSent((s) => new Set(s).add(conversationId));
      countShare();
    } catch (e) {
      notify({ title: 'Could not send the post', body: e instanceof Error ? e.message : undefined, tone: 'error' });
    } finally {
      setSending(null);
    }
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setManualCopy(false);
      countShare();
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // The clipboard can be refused (an insecure page, a browser setting):
      // the link is shown, selected, to copy by hand.
      setManualCopy(true);
      requestAnimationFrame(() => { linkRef.current?.focus(); linkRef.current?.select(); });
    }
  };

  const viaDevice = async () => {
    try {
      await navigator.share({ url, title: `${post.page.name} on Tupo` });
      countShare();
      onClose();
    } catch { /* cancelled: nothing to say */ }
  };

  const snippet = post.body.trim().slice(0, 120) || (post.media.length ? 'Photo or video' : 'Post');

  return createPortal(
    <div className="fixed inset-0 z-[110] flex items-end justify-center bg-black/50 sm:items-center sm:p-4" onClick={onClose}>
      <div
        role="dialog" aria-modal="true" aria-label="Share post"
        onClick={(e) => e.stopPropagation()}
        className="pb-safe flex max-h-[85vh] w-full max-w-md flex-col overflow-hidden rounded-t-2xl border border-border-light bg-white animate-pop sm:rounded-2xl dark:border-border-dark/50 dark:bg-elevated-dark"
      >
        <header className="flex items-center gap-2 border-b border-border-light px-4 py-3 dark:border-border-dark/40">
          <Share2 size={17} className="text-blue-600 dark:text-blue-400" />
          <h2 className="flex-1 text-[15px] font-semibold text-text-primary-light dark:text-text-primary-dark">Share post</h2>
          <button onClick={onClose} aria-label="Close" className="grid h-9 w-9 place-items-center rounded-full text-text-secondary-light hover:bg-surface-light dark:text-text-secondary-dark dark:hover:bg-card-dark">
            <X size={18} />
          </button>
        </header>

        <p className="mx-4 mt-3 line-clamp-2 rounded-lg bg-surface-light px-3 py-2 text-[13px] text-text-secondary-light dark:bg-card-dark/50 dark:text-text-secondary-dark">
          <span className="font-semibold text-text-primary-light dark:text-text-primary-dark">{post.page.name}</span> · {snippet}
        </p>

        <div className="grid grid-cols-3 gap-2 px-4 py-3">
          <button onClick={() => void copy()} className={shareBtn}>
            {copied ? <Check size={20} className="text-blue-600" /> : <Copy size={20} />}
            {copied ? 'Copied' : 'Copy link'}
          </button>
          {typeof navigator !== 'undefined' && typeof navigator.share === 'function' ? (
            <button onClick={() => void viaDevice()} className={shareBtn}><Share2 size={20} /> Share via…</button>
          ) : <span />}
          <Link to={`/app/feed/post/${post.id}`} onClick={onClose} className={shareBtn}><ExternalLink size={20} /> Open post</Link>
        </div>
        {manualCopy && (
          <div className="px-4 pb-3">
            <label className="mb-1 block text-xs font-medium text-text-secondary-light dark:text-text-secondary-dark" htmlFor="share-link">
              Copying is blocked here. Select the link and copy it:
            </label>
            <input id="share-link" ref={linkRef} readOnly value={url} onFocus={(e) => e.currentTarget.select()}
              className="w-full rounded-lg border border-border-light bg-surface-light px-3 py-2 text-sm text-text-primary-light dark:border-border-dark/50 dark:bg-card-dark dark:text-text-primary-dark" />
          </div>
        )}

        <div className="border-t border-border-light px-4 pt-3 dark:border-border-dark/40">
          <p className="mb-2 text-[13px] font-semibold text-text-primary-light dark:text-text-primary-dark">Send in chat</p>
          <div className="flex items-center gap-2 rounded-xl border border-border-light bg-surface-light px-3 dark:border-border-dark/50 dark:bg-card-dark/50">
            <Search size={15} className="text-text-secondary-light dark:text-text-secondary-dark" />
            <input ref={searchRef} value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search people and channels"
              aria-label="Search conversations"
              className="min-h-10 flex-1 bg-transparent text-sm text-text-primary-light outline-none dark:text-text-primary-dark" />
          </div>
        </div>
        <ul className="min-h-[6rem] flex-1 overflow-y-auto px-2 py-2" aria-label="Conversations">
          {targets.length === 0 && (
            <li className="px-3 py-6 text-center text-sm text-text-secondary-light dark:text-text-secondary-dark">
              {conversations.length === 0 ? 'Loading your conversations…' : 'No conversation matches.'}
            </li>
          )}
          {targets.map((c) => {
            const done = sent.has(c.id);
            const busy = sending === c.id;
            return (
              <li key={c.id} className="flex items-center gap-3 rounded-lg px-2 py-1.5 hover:bg-surface-light dark:hover:bg-card-dark/50">
                <ConversationAvatar conversation={c} size={36} />
                <span className="min-w-0 flex-1 truncate text-sm font-medium text-text-primary-light dark:text-text-primary-dark">{c.name}</span>
                <button
                  onClick={() => void sendTo(c.id)}
                  disabled={busy || done}
                  aria-label={done ? `Sent to ${c.name}` : `Send to ${c.name}`}
                  className={`flex min-h-9 items-center gap-1.5 rounded-full px-3.5 text-[13px] font-semibold transition-colors ${
                    done ? 'bg-blue-50 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300' : 'bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-70'
                  }`}
                >
                  {busy ? <Loader2 size={14} className="animate-spin" /> : done ? <Check size={14} /> : <Send size={14} />}
                  {done ? 'Sent' : 'Send'}
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    </div>,
    document.body,
  );
};

const shareBtn = 'flex min-h-16 flex-col items-center justify-center gap-1 rounded-xl border border-border-light text-[13px] font-medium text-text-primary-light transition-colors hover:bg-blue-50 dark:border-border-dark/50 dark:text-text-primary-dark dark:hover:bg-blue-900/20';
