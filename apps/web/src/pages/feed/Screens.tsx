import React, { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, Bookmark, ShieldAlert, Check, Trash2, AlertTriangle } from 'lucide-react';
import type { FeedPostView, FeedReportView } from '@tupo/shared';
import { Avatar, EmptyState, Spinner } from '../../components/ui';
import { useFeed, useFeedList } from './FeedProvider';
import { FeedFrame, PostSkeleton, PostCard, ReportDialog, EditPostMount } from './Frame';
import { relativeTime } from './lib';
import * as api from './api';

/* ═══════════════════════════════════════════════════════════ Saved ══ */

export const SavedPosts: React.FC = () => {
  const { posts } = useFeed();
  const list = useFeedList(useCallback((cursor?: string) => api.getBookmarks(cursor), []), []);
  const items = list.ids.map((id) => posts[id]).filter((p): p is FeedPostView => Boolean(p));
  return (
    <>
      <FeedFrame>
        <div className="mx-auto max-w-2xl">
          <h1 className="mb-4 flex items-center gap-2 text-lg font-bold text-text-primary-light dark:text-text-primary-dark"><Bookmark size={18} /> Saved posts</h1>
          {list.loading ? <><PostSkeleton /><PostSkeleton /></>
            : items.length === 0 ? <EmptyState title="Nothing saved yet" hint="Tap the bookmark on any post to keep it here." />
            : <div className="space-y-4">{items.map((p) => <PostCard key={p.id} post={p} />)}</div>}
          {list.hasMore && <button onClick={list.loadMore} className="mx-auto mt-4 block rounded-full border border-border-light px-5 py-2 text-sm font-semibold dark:border-border-dark/50">Load more</button>}
        </div>
      </FeedFrame>
      <ReportDialog />
      <EditPostMount pages={[]} />
    </>
  );
};

/* ═════════════════════════════════════════════════════════ Permalink ══ */

export const PostPermalink: React.FC = () => {
  const { id = '' } = useParams();
  const { getPost, ingest } = useFeed();
  const [status, setStatus] = useState<'loading' | 'ok' | 'gone'>('loading');
  const post = getPost(id);

  useEffect(() => {
    setStatus('loading');
    void api.getPost(id).then((p) => { ingest([p]); setStatus('ok'); }).catch(() => setStatus('gone'));
  }, [id, ingest]);

  return (
    <>
      <FeedFrame>
        <div className="mx-auto max-w-2xl">
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
      <EditPostMount pages={[]} />
    </>
  );
};

/* ═══════════════════════════════════════════════════════ Moderation ══ */

export const ModerationQueue: React.FC = () => {
  const [tab, setTab] = useState<'open' | 'actioned' | 'dismissed'>('open');
  const [reports, setReports] = useState<FeedReportView[] | null>(null);

  const reload = useCallback(() => { setReports(null); void api.getModerationQueue(tab).then(setReports); }, [tab]);
  useEffect(reload, [reload]);

  const act = async (r: FeedReportView, action: 'remove' | 'warn' | 'dismiss') => {
    await api.actOnReport(r.id, action);
    setReports((prev) => prev?.filter((x) => x.id !== r.id) ?? null);
  };

  return (
    <FeedFrame>
      <div className="mx-auto max-w-2xl">
        <h1 className="mb-3 flex items-center gap-2 text-lg font-bold text-text-primary-light dark:text-text-primary-dark">
          <ShieldAlert size={18} /> Moderation queue
        </h1>
        <div className="mb-4 flex gap-1 border-b border-border-light dark:border-border-dark/40">
          {(['open', 'actioned', 'dismissed'] as const).map((t) => (
            <button key={t} onClick={() => setTab(t)} className={`px-4 py-2 text-sm font-semibold capitalize ${
              tab === t ? 'border-b-2 border-blue-600 text-blue-600 dark:text-blue-400' : 'text-text-secondary-light dark:text-text-secondary-dark'
            }`}>{t}</button>
          ))}
        </div>
        {!reports ? <div className="py-10 text-center"><Spinner /></div>
          : reports.length === 0 ? <EmptyState title={tab === 'open' ? 'Queue is clear' : `No ${tab} reports`} hint={tab === 'open' ? 'Nothing needs review right now.' : undefined} />
          : (
          <ul className="space-y-3">
            {reports.map((r) => (
              <li key={r.id} className="rounded-2xl border border-border-light bg-card-light p-4 dark:border-border-dark/40 dark:bg-elevated-dark/40">
                <div className="flex items-center gap-2 text-xs text-text-secondary-light dark:text-text-secondary-dark">
                  <span className="rounded-full bg-red-100 px-2 py-0.5 font-semibold capitalize text-red-700 dark:bg-red-900/30 dark:text-red-300">{r.reason.replace('_', ' ')}</span>
                  <span className="capitalize">{r.targetType}</span>
                  <span>· reported by {r.reporter.name}</span>
                  <span>· {relativeTime(r.createdAt)}</span>
                </div>
                {r.note && <p className="mt-1.5 text-xs italic text-text-secondary-light dark:text-text-secondary-dark">“{r.note}”</p>}
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
                    <button onClick={() => void act(r, 'remove')} className="inline-flex items-center gap-1.5 rounded-full bg-red-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-red-700"><Trash2 size={13} /> Remove content</button>
                    <button onClick={() => void act(r, 'warn')} className="inline-flex items-center gap-1.5 rounded-full border border-amber-400 px-3 py-1.5 text-xs font-semibold text-amber-600 hover:bg-amber-50 dark:text-amber-400 dark:hover:bg-amber-900/20"><AlertTriangle size={13} /> Warn author</button>
                    <button onClick={() => void act(r, 'dismiss')} className="inline-flex items-center gap-1.5 rounded-full border border-border-light px-3 py-1.5 text-xs font-semibold text-text-secondary-light hover:bg-surface-light dark:border-border-dark/60 dark:text-text-secondary-dark"><Check size={13} /> Dismiss</button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </FeedFrame>
  );
};
