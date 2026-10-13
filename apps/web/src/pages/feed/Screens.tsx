import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useNotify } from '../../context/NotificationContext';
import { useConfirmDialog } from '../../components/ConfirmDialog';
import { LoadError } from '../../components/LoadError';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, Bookmark, ShieldAlert, Check, Trash2, AlertTriangle } from 'lucide-react';
import type { FeedPostView, FeedReportView } from '@tupo/shared';
import { Avatar, EmptyState, Spinner } from '../../components/ui';
import { useFeed, useFeedList } from './FeedProvider';
import { FeedFrame, useFeedRails, PostSkeleton, PostCard, ReportDialog, EditPostMount } from './Frame';
import { relativeTime } from './lib';
import * as api from './api';
import { ChatReportsQueue } from '../chat/ChatReportsQueue';

/* ═══════════════════════════════════════════════════════════ Saved ══ */

export const SavedPosts: React.FC = () => {
  const { posts } = useFeed();
  const list = useFeedList(useCallback((cursor?: string) => api.getBookmarks(cursor), []), []);
  const items = list.ids.map((id) => posts[id]).filter((p): p is FeedPostView => Boolean(p));
  const { pages, left, right } = useFeedRails();
  return (
    <>
      <FeedFrame left={left} right={right}>
        <div className="mx-auto max-w-2xl px-3 pt-3 sm:px-0 sm:pt-0">
          {/* The rail hides under 980px, so this is the only way back on a phone. */}
          <Link to="/app/feed" className="mb-3 inline-flex items-center gap-1.5 text-sm font-medium text-text-secondary-light hover:text-text-primary-light lg:hidden dark:text-text-secondary-dark">
            <ArrowLeft size={15} /> Back to feed
          </Link>
          <h1 className="mb-4 flex items-center gap-2 text-lg font-bold text-text-primary-light dark:text-text-primary-dark"><Bookmark size={18} /> Saved posts</h1>
          {list.loading ? <><PostSkeleton /><PostSkeleton /></>
            : items.length === 0 ? <EmptyState title="Nothing saved yet" hint="Tap the bookmark on any post to keep it here." />
            : <div className="space-y-4">{items.map((p) => <PostCard key={p.id} post={p} />)}</div>}
          {list.hasMore && <button onClick={list.loadMore} className="mx-auto mt-4 block rounded-full border border-border-light px-5 py-2 text-sm font-semibold dark:border-border-dark/50">Load more</button>}
        </div>
      </FeedFrame>
      <ReportDialog />
      <EditPostMount pages={pages} />
    </>
  );
};

/* ═════════════════════════════════════════════════════════ Permalink ══ */

export const PostPermalink: React.FC = () => {
  const { id = '' } = useParams();
  const { getPost, ingest, watch } = useFeed();
  const [status, setStatus] = useState<'loading' | 'ok' | 'gone'>('loading');
  const post = getPost(id);
  const { pages, left, right } = useFeedRails();

  useEffect(() => {
    setStatus('loading');
    // Subscribed as well as fetched: comments, reactions and edits arrive live
    // on a post's own page just as they do in the feed.
    void api.getPost(id).then((p) => { ingest([p]); watch([p.id]); setStatus('ok'); }).catch(() => setStatus('gone'));
  }, [id, ingest, watch]);

  return (
    <>
      <FeedFrame left={left} right={right}>
        <div className="mx-auto max-w-2xl px-3 pt-3 sm:px-0 sm:pt-0">
          <Link to="/app/feed" className="mb-3 inline-flex items-center gap-1.5 text-sm font-medium text-text-secondary-light hover:text-text-primary-light dark:text-text-secondary-dark">
            <ArrowLeft size={15} /> Back to feed
          </Link>
          {status === 'loading' && !post ? <PostSkeleton />
            : status === 'gone' ? <EmptyState title="Post unavailable" hint="It may have been removed or is not visible to you." />
            : post ? <PostCard post={post} permalink />
            : <PostSkeleton />}
        </div>
      </FeedFrame>
      <ReportDialog />
      <EditPostMount pages={pages} />
    </>
  );
};

/* ═══════════════════════════════════════════════════════ Moderation ══ */

export const ModerationQueue: React.FC = () => {
  // Feed posts and comments, or people and chat messages (B-05).
  const [source, setSource] = useState<'feed' | 'chat'>('feed');
  const [tab, setTab] = useState<'open' | 'actioned' | 'dismissed'>('open');
  const [reports, setReports] = useState<FeedReportView[] | null>(null);

  const { notify, confirm: confirmed } = useNotify();
  const [ask, dialog] = useConfirmDialog();
  const [failed, setFailed] = useState(false);
  const reload = useCallback(() => {
    setReports(null); setFailed(false);
    void api.getModerationQueue(tab).then(setReports).catch(() => setFailed(true));
  }, [tab]);
  useEffect(reload, [reload]);

  /*
   * One card per reported item (D-10): five reports of the same post are one
   * decision, with every reason and reporter shown. Removing and warning ask
   * first and say what happened; a report someone else already handled says so.
   */
  const groups = useMemo(() => {
    const by = new Map<string, FeedReportView[]>();
    for (const r of reports ?? []) {
      const key = `${r.targetType}:${r.targetId}`;
      by.set(key, [...(by.get(key) ?? []), r]);
    }
    return [...by.values()];
  }, [reports]);
  const act = async (items: FeedReportView[], action: 'remove' | 'warn' | 'dismiss') => {
    const r = items[0]!;
    const what = r.targetType === 'post' ? 'post' : 'comment';
    if (action !== 'dismiss') {
      const ok = await ask(action === 'remove'
        ? { title: `Remove this ${what}?`, body: <p>It disappears for everyone and its author is told why. {items.length > 1 ? `All ${items.length} reports about it are closed.` : ''}</p>, confirmLabel: 'Remove', tone: 'danger' }
        : { title: 'Warn the author?', body: <p>They get a notice to keep to the community rules. The {what} stays up.</p>, confirmLabel: 'Send warning' });
      if (!ok) return;
    }
    try {
      await api.actOnReport(r.id, action);
      confirmed(action === 'remove' ? `The ${what} was removed` : action === 'warn' ? 'The author was warned' : 'Report dismissed');
    } catch (e) {
      notify({ title: e instanceof Error ? e.message : 'That did not work', tone: 'error' });
    }
    const ids = new Set(items.map((x) => x.id));
    setReports((prev) => prev?.filter((x) => !ids.has(x.id)) ?? null);
  };
  const { left, right } = useFeedRails();

  return (
    <FeedFrame left={left} right={right}>
      <div className="mx-auto max-w-2xl px-3 pt-3 sm:px-0 sm:pt-0">
        <Link to="/app/feed" className="mb-3 inline-flex items-center gap-1.5 text-sm font-medium text-text-secondary-light hover:text-text-primary-light lg:hidden dark:text-text-secondary-dark">
          <ArrowLeft size={15} /> Back to feed
        </Link>
        <h1 className="mb-3 flex items-center gap-2 text-lg font-bold text-text-primary-light dark:text-text-primary-dark">
          <ShieldAlert size={18} /> Moderation queue
        </h1>
        <div role="tablist" className="mb-3 inline-flex rounded-full bg-surface-light p-1 dark:bg-card-dark/60">
          {(['feed', 'chat'] as const).map((s) => (
            <button key={s} role="tab" aria-selected={source === s} onClick={() => setSource(s)}
              className={`rounded-full px-4 py-1.5 text-xs font-semibold ${source === s
                ? 'bg-white text-text-primary-light shadow-sm dark:bg-elevated-dark dark:text-text-primary-dark'
                : 'text-text-secondary-light dark:text-text-secondary-dark'}`}>
              {s === 'feed' ? 'Posts & comments' : 'People & messages'}
            </button>
          ))}
        </div>
        {source === 'chat' ? <ChatReportsQueue /> : (<>
        <div className="mb-4 flex gap-1 border-b border-border-light dark:border-border-dark/40">
          {(['open', 'actioned', 'dismissed'] as const).map((t) => (
            <button key={t} onClick={() => setTab(t)} className={`px-4 py-2 text-sm font-semibold capitalize ${
              tab === t ? 'border-b-2 border-blue-600 text-blue-600 dark:text-blue-400' : 'text-text-secondary-light dark:text-text-secondary-dark'
            }`}>{t}</button>
          ))}
        </div>
        {failed ? <LoadError what="the moderation queue" onRetry={reload} />
          : !reports ? <div className="py-10 text-center"><Spinner /></div>
          : reports.length === 0 ? <EmptyState title={tab === 'open' ? 'Queue is clear' : `No ${tab} reports`} hint={tab === 'open' ? 'Nothing needs review right now.' : undefined} />
          : (
          <ul className="space-y-3">
            {groups.map((items) => {
              const r = items[0]!;
              const reasons = [...new Set(items.map((x) => x.reason))];
              return (
              <li key={`${r.targetType}:${r.targetId}`} className="rounded-2xl border border-border-light bg-card-light p-4 dark:border-border-dark/40 dark:bg-elevated-dark/40">
                <div className="flex flex-wrap items-center gap-2 text-xs text-text-secondary-light dark:text-text-secondary-dark">
                  {reasons.map((reason) => (
                    <span key={reason} className="rounded-full bg-red-100 px-2 py-0.5 font-semibold capitalize text-red-700 dark:bg-red-900/30 dark:text-red-300">{reason.replace('_', ' ')}</span>
                  ))}
                  <span className="capitalize">{r.targetType}</span>
                  <span>· {items.length > 1 ? `${items.length} reports` : `reported by ${r.reporter.name}`}</span>
                  <span>· {relativeTime(items[items.length - 1]!.createdAt)}</span>
                </div>
                {items.length > 1 && (
                  <p className="mt-1 text-xs text-text-secondary-light dark:text-text-secondary-dark">
                    By {items.map((x) => x.reporter.name).filter((n, i, a) => a.indexOf(n) === i).join(', ')}
                  </p>
                )}
                {items.filter((x) => x.note).map((x) => (
                  <p key={x.id} className="mt-1.5 text-xs italic text-text-secondary-light dark:text-text-secondary-dark">“{x.note}” — {x.reporter.name}</p>
                ))}
                {r.preview && (
                  <div className="mt-2 rounded-xl border border-border-light bg-surface-light p-3 dark:border-border-dark/50 dark:bg-card-dark/40">
                    <p className="flex items-center gap-1.5 text-xs font-semibold text-text-primary-light dark:text-text-primary-dark">
                      <Avatar name={r.preview.author.name} src={r.preview.author.avatarUrl ?? undefined} size={18} />
                      {r.preview.author.name}{r.preview.pageName ? ` · ${r.preview.pageName}` : ''}
                      {r.preview.removed && <span className="rounded bg-slate-200 px-1 text-[10px] dark:bg-card-dark">removed</span>}
                    </p>
                    <p className="mt-1 whitespace-pre-wrap break-words text-sm text-text-primary-light dark:text-text-primary-dark">{r.preview.body || '(no text)'}</p>
                    {r.postId && <Link to={`/app/feed/post/${r.postId}`} className="mt-1 inline-block text-xs font-medium text-blue-600 hover:underline dark:text-blue-400">Open in context →</Link>}
                  </div>
                )}
                {tab === 'open' && (
                  <div className="mt-3 flex flex-wrap gap-2">
                    <button onClick={() => void act(items, 'remove')} className="inline-flex items-center gap-1.5 rounded-full bg-red-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-red-700"><Trash2 size={13} /> Remove content</button>
                    <button onClick={() => void act(items, 'warn')} className="inline-flex items-center gap-1.5 rounded-full border border-amber-400 px-3 py-1.5 text-xs font-semibold text-amber-600 hover:bg-amber-50 dark:text-amber-400 dark:hover:bg-amber-900/20"><AlertTriangle size={13} /> Warn author</button>
                    <button onClick={() => void act(items, 'dismiss')} className="inline-flex items-center gap-1.5 rounded-full border border-border-light px-3 py-1.5 text-xs font-semibold text-text-secondary-light hover:bg-surface-light dark:border-border-dark/60 dark:text-text-secondary-dark"><Check size={13} /> {items.length > 1 ? 'Dismiss all' : 'Dismiss'}</button>
                  </div>
                )}
              </li>
              );
            })}
          </ul>
        )}
        </>)}
      </div>
      {dialog}
    </FeedFrame>
  );
};
