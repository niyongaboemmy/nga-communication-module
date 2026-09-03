import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Heart, CornerDownRight, MoreHorizontal, Trash2, Pencil, Flag } from 'lucide-react';
import type { FeedCommentView, FeedPostView } from '@tupo/shared';
import { Avatar, Spinner } from '../../components/ui';
import { useFeed } from './FeedProvider';
import { relativeTime, renderRichText } from './lib';
import * as api from './api';

interface Props { post: FeedPostView; autoFocus?: boolean; }

export const Comments: React.FC<Props> = ({ post, autoFocus }) => {
  const { onCommentEvent, currentUserId } = useFeed();
  const [items, setItems] = useState<FeedCommentView[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (reset: boolean) => {
    const page = await api.listComments(post.id, reset ? undefined : cursor ?? undefined);
    setItems((prev) => (reset ? page.items : [...prev, ...page.items.filter((c) => !prev.some((p) => p.id === c.id))]));
    setCursor(page.nextCursor);
    setLoading(false);
  }, [post.id, cursor]);

  useEffect(() => { void load(true); /* eslint-disable-next-line */ }, [post.id]);

  useEffect(() => onCommentEvent((e) => {
    if (e.postId !== post.id) return;
    setItems((prev) => {
      if (e.type === 'new') {
        if (prev.some((c) => c.id === e.comment.id)) return prev;
        if (e.comment.parentId) {
          return prev.map((c) => c.id === e.comment.parentId
            ? { ...c, replyCount: c.replyCount + 1, replies: [...(c.replies ?? []), e.comment] }
            : c);
        }
        return [...prev, e.comment];
      }
      if (e.type === 'updated') {
        return prev.map((c) => c.id === e.comment.id ? { ...c, ...e.comment, replies: c.replies }
          : { ...c, replies: c.replies?.map((r) => r.id === e.comment.id ? { ...r, ...e.comment } : r) });
      }
      if (e.type === 'deleted') {
        if (e.parentId) return prev.map((c) => c.id === e.parentId
          ? { ...c, replyCount: Math.max(0, c.replyCount - 1), replies: c.replies?.filter((r) => r.id !== e.commentId) }
          : c);
        return prev.filter((c) => c.id !== e.commentId);
      }
      if (e.type === 'reaction') {
        return prev.map((c) => c.id === e.commentId ? { ...c, reactionCount: e.reactionCount }
          : { ...c, replies: c.replies?.map((r) => r.id === e.commentId ? { ...r, reactionCount: e.reactionCount } : r) });
      }
      return prev;
    });
  }), [onCommentEvent, post.id]);

  return (
    <div className="border-t border-border-light px-4 py-3 dark:border-border-dark/40">
      {post.canComment && <CommentComposer postId={post.id} autoFocus={autoFocus} onAdded={(c) => setItems((p) => p.some((x) => x.id === c.id) ? p : [...p, c])} />}
      {loading ? (
        <div className="py-4 text-center"><Spinner /></div>
      ) : (
        <ul className="mt-3 space-y-3">
          {items.map((c) => (
            <CommentNode key={c.id} comment={c} postId={post.id} canComment={post.canComment} currentUserId={currentUserId}
              onLocalReplyAdded={(reply) => setItems((prev) => prev.map((x) => x.id === c.id
                ? { ...x, replyCount: x.replyCount + 1, replies: [...(x.replies ?? []), reply] } : x))} />
          ))}
        </ul>
      )}
      {cursor && (
        <button onClick={() => void load(false)} className="mt-3 text-xs font-semibold text-blue-600 hover:underline dark:text-blue-400">
          View more comments
        </button>
      )}
    </div>
  );
};

const CommentNode: React.FC<{
  comment: FeedCommentView; postId: string; canComment: boolean; currentUserId: string;
  onLocalReplyAdded: (c: FeedCommentView) => void; depth?: number;
}> = ({ comment, postId, canComment, currentUserId, onLocalReplyAdded, depth = 0 }) => {
  const [replying, setReplying] = useState(false);
  const [editing, setEditing] = useState(false);
  const [showReplies, setShowReplies] = useState(depth === 0 && (comment.replies?.length ?? 0) > 0);
  const [replies, setReplies] = useState<FeedCommentView[]>(comment.replies ?? []);
  const [repliesCursor, setRepliesCursor] = useState<string | null>(null);
  const [liked, setLiked] = useState(comment.myReaction !== null);
  const [count, setCount] = useState(comment.reactionCount);
  const [menu, setMenu] = useState(false);
  const [body, setBody] = useState(comment.body);

  useEffect(() => { setReplies(comment.replies ?? []); }, [comment.replies]);
  useEffect(() => { setCount(comment.reactionCount); }, [comment.reactionCount]);

  const toggleLike = async () => {
    const next = !liked;
    setLiked(next); setCount((c) => c + (next ? 1 : -1));
    try { await api.reactToComment(comment.id, next ? 'like' : null); }
    catch { setLiked(!next); setCount((c) => c + (next ? -1 : 1)); }
  };

  const loadMoreReplies = async () => {
    const page = await api.listReplies(comment.id, repliesCursor ?? undefined);
    setReplies((prev) => [...prev, ...page.items.filter((r) => !prev.some((x) => x.id === r.id))]);
    setRepliesCursor(page.nextCursor);
    setShowReplies(true);
  };

  const remaining = comment.replyCount - replies.length;

  return (
    <li className="flex gap-2">
      <Avatar name={comment.author.name} src={comment.author.avatarUrl ?? undefined} size={depth ? 26 : 32} />
      <div className="min-w-0 flex-1">
        <div className="group inline-block max-w-full rounded-2xl bg-surface-light px-3 py-2 dark:bg-card-dark/50">
          <p className="flex items-center gap-1.5 text-xs">
            <span className="font-semibold text-text-primary-light dark:text-text-primary-dark">{comment.author.name}</span>
            {comment.author.roleName && <span className="text-[11px] text-text-secondary-light dark:text-text-secondary-dark">· {comment.author.roleName}</span>}
          </p>
          {editing ? (
            <InlineEdit initial={body} onCancel={() => setEditing(false)} onSave={async (v) => {
              const updated = await api.editComment(comment.id, v);
              setBody(updated.body); setEditing(false);
            }} />
          ) : (
            <p className="whitespace-pre-wrap break-words text-sm text-text-primary-light dark:text-text-primary-dark">{renderRichText(body)}</p>
          )}
        </div>
        <div className="mt-1 flex items-center gap-3 pl-1 text-[11px] font-semibold text-text-secondary-light dark:text-text-secondary-dark">
          <button onClick={toggleLike} className={`flex items-center gap-1 transition-colors hover:text-rose-500 ${liked ? 'text-rose-500' : ''}`}>
            <Heart size={12} className={liked ? 'fill-rose-500' : ''} /> {count > 0 ? count : 'Like'}
          </button>
          {canComment && depth === 0 && (
            <button onClick={() => setReplying((v) => !v)} className="hover:text-blue-600 dark:hover:text-blue-400">Reply</button>
          )}
          <span className="font-normal">{relativeTime(comment.createdAt)}{comment.editedAt ? ' · edited' : ''}</span>
          {(comment.canEdit || comment.canModerate) && (
            <div className="relative">
              <button onClick={() => setMenu((v) => !v)} aria-label="Comment actions" className="hover:text-text-primary-light dark:hover:text-text-primary-dark"><MoreHorizontal size={13} /></button>
              {menu && (
                <div className="animate-pop absolute left-0 top-full z-20 mt-1 w-36 rounded-xl border border-border-light bg-white p-1 shadow-lg dark:border-border-dark/60 dark:bg-elevated-dark" onMouseLeave={() => setMenu(false)}>
                  {comment.canEdit && <button onClick={() => { setEditing(true); setMenu(false); }} className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs hover:bg-surface-light dark:hover:bg-card-dark"><Pencil size={12} /> Edit</button>}
                  {(comment.canEdit || comment.canModerate) && <button onClick={() => { void api.deleteComment(comment.id); setMenu(false); }} className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20"><Trash2 size={12} /> Delete</button>}
                  {comment.author.id !== currentUserId && <button onClick={() => { void api.reportComment(comment.id, 'other'); setMenu(false); }} className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs hover:bg-surface-light dark:hover:bg-card-dark"><Flag size={12} /> Report</button>}
                </div>
              )}
            </div>
          )}
        </div>

        {replying && (
          <div className="mt-2">
            <CommentComposer postId={postId} parentId={comment.id} compact autoFocus
              onAdded={(c) => { onLocalReplyAdded(c); setReplies((p) => [...p, c]); setReplying(false); setShowReplies(true); }} />
          </div>
        )}

        {!showReplies && comment.replyCount > 0 && (
          <button onClick={() => (replies.length ? setShowReplies(true) : void loadMoreReplies())}
            className="mt-1.5 flex items-center gap-1 pl-1 text-[11px] font-semibold text-blue-600 hover:underline dark:text-blue-400">
            <CornerDownRight size={11} /> {comment.replyCount} {comment.replyCount === 1 ? 'reply' : 'replies'}
          </button>
        )}
        {showReplies && (
          <ul className="mt-2 space-y-2">
            {replies.map((r) => (
              <CommentNode key={r.id} comment={r} postId={postId} canComment={canComment} currentUserId={currentUserId} onLocalReplyAdded={onLocalReplyAdded} depth={depth + 1} />
            ))}
            {remaining > 0 && (
              <button onClick={() => void loadMoreReplies()} className="pl-1 text-[11px] font-semibold text-blue-600 hover:underline dark:text-blue-400">
                View {remaining} more {remaining === 1 ? 'reply' : 'replies'}
              </button>
            )}
          </ul>
        )}
      </div>
    </li>
  );
};

const InlineEdit: React.FC<{ initial: string; onSave: (v: string) => Promise<void>; onCancel: () => void }> = ({ initial, onSave, onCancel }) => {
  const [v, setV] = useState(initial);
  const [busy, setBusy] = useState(false);
  return (
    <div className="mt-1">
      <textarea value={v} onChange={(e) => setV(e.target.value)} rows={2} autoFocus
        className="w-full resize-none rounded-lg border border-border-light bg-white px-2 py-1 text-sm dark:border-border-dark/60 dark:bg-elevated-dark" />
      <div className="mt-1 flex gap-2 text-xs">
        <button disabled={busy} onClick={async () => { setBusy(true); try { await onSave(v.trim()); } finally { setBusy(false); } }}
          className="font-semibold text-blue-600 hover:underline dark:text-blue-400">Save</button>
        <button onClick={onCancel} className="text-text-secondary-light dark:text-text-secondary-dark">Cancel</button>
      </div>
    </div>
  );
};

const CommentComposer: React.FC<{
  postId: string; parentId?: string; compact?: boolean; autoFocus?: boolean;
  onAdded: (c: FeedCommentView) => void;
}> = ({ postId, parentId, compact, autoFocus, onAdded }) => {
  const [v, setV] = useState('');
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { if (autoFocus) ref.current?.focus(); }, [autoFocus]);

  const submit = async () => {
    const body = v.trim();
    if (!body || busy) return;
    setBusy(true);
    try {
      const c = await api.addComment(postId, body, parentId);
      onAdded(c);
      setV('');
    } finally { setBusy(false); }
  };

  return (
    <div className={`flex items-end gap-2 ${compact ? '' : 'mt-1'}`}>
      <textarea
        ref={ref}
        value={v}
        onChange={(e) => setV(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void submit(); }}
        placeholder={parentId ? 'Write a reply…' : 'Write a comment…'}
        rows={1}
        className="max-h-32 min-h-[2.25rem] flex-1 resize-none rounded-2xl border border-border-light bg-surface-light px-3 py-2 text-sm text-text-primary-light outline-none focus:border-blue-400 dark:border-border-dark/60 dark:bg-card-dark/50 dark:text-text-primary-dark"
      />
      <button
        onClick={() => void submit()}
        disabled={!v.trim() || busy}
        className="shrink-0 rounded-full bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white transition-opacity disabled:opacity-40"
      >
        Post
      </button>
    </div>
  );
};
