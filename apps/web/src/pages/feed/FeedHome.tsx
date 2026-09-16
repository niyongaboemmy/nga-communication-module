import React, { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ArrowUp, CircleCheck, Clock, Flame, Sparkles, X } from 'lucide-react';
import type { FeedFilter, FeedPostView, FeedSort } from '@tupo/shared';
import { EmptyState } from '../../components/ui';
import { useFeed, useFeedList } from './FeedProvider';
import { FeedFrame, useFeedRails, ReportDialog, EditPostMount, PostSkeleton, PostCard, LoadMoreSentinel } from './Frame';
import { Composer } from './Composer';
import { HighlightsBar } from './HighlightsBar';
import * as api from './api';

export const FeedHome: React.FC = () => {
  const [params, setParams] = useSearchParams();
  const filter = (params.get('filter') as FeedFilter) || 'all';
  const [sort, setSort] = useState<FeedSort>('recent');
  const { posts, ingest, currentUserId } = useFeed();
  const [pendingTop, setPendingTop] = useState<FeedPostView[]>([]);
  const { pages, left, right } = useFeedRails();

  const loader = useCallback(
    (cursor?: string) => api.getFeed({ cursor, sort, filter: filter === 'all' ? undefined : filter }),
    [sort, filter],
  );
  const list = useFeedList(loader, [sort, filter]);

  // Live posts land in a "new posts" pill rather than jumping the scroll.
  useEffect(() => list.onNewPost((post) => {
    if (list.ids.includes(post.id) || post.author.id === currentUserId) return;
    if (filter === 'announcements' && post.type !== 'announcement') return;
    setPendingTop((p) => (p.some((x) => x.id === post.id) ? p : [post, ...p]));
  }), [list, filter]);

  const showPending = () => {
    ingest(pendingTop);
    pendingTop.forEach((p) => list.prepend(p.id));
    setPendingTop([]);
    document.querySelector('[data-app-scroll]')?.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const items = list.ids.map((id) => posts[id]).filter((p): p is FeedPostView => Boolean(p));

  return (
    <>
      <FeedFrame left={left} right={right}>
        <div className="relative space-y-3 pt-0 sm:pt-0">
          <HighlightsBar />
          <Composer pages={pages} onPublished={(post) => { if (post) { list.prepend(post.id); ingest([post]); } }} />

          <div className="flex items-center gap-2 px-3 sm:px-0">
            <div className="flex items-center gap-0.5 rounded-full bg-black/[0.06] p-0.5 text-[13px] dark:bg-white/[0.06]">
              <SortTab active={sort === 'recent'} onClick={() => setSort('recent')} icon={<Clock size={13} />} label="Latest" />
              <SortTab active={sort === 'top'} onClick={() => setSort('top')} icon={<Flame size={13} />} label="Top" />
            </div>
            <span className="flex-1" />
            {filter !== 'all' && (
              <button onClick={() => setParams({})} aria-label={`Clear the ${filter} filter`} className="inline-flex items-center gap-1 rounded-full bg-blue-50 py-1 pl-3 pr-2 text-xs font-semibold capitalize text-blue-600 transition-colors hover:bg-blue-100 dark:bg-blue-900/25 dark:text-blue-300 dark:hover:bg-blue-900/40">
                {filter} <X size={12} aria-hidden />
              </button>
            )}
          </div>

          {pendingTop.length > 0 && (
            <button
              onClick={showPending}
              className="feed-pill-in sticky top-2 z-20 left-1/2 flex -translate-x-1/2 items-center gap-1.5 rounded-full bg-blue-600 px-4 py-2 text-[13px] font-semibold text-white shadow-[0_6px_20px_rgba(37,99,235,0.45)]"
            >
              <ArrowUp size={14} /> {pendingTop.length} new {pendingTop.length === 1 ? 'post' : 'posts'}
            </button>
          )}

          {list.loading ? (
            <><PostSkeleton /><PostSkeleton /></>
          ) : list.error ? (
            <div className="feed-card p-6"><EmptyState title="Could not load the feed" hint={list.error} /></div>
          ) : items.length === 0 ? (
            <div className="feed-card p-6">
              <EmptyState
                title={filter === 'following' ? 'Nothing from your pages yet' : 'The feed is quiet'}
                hint={filter === 'following' ? 'Follow a few more pages to fill this up.' : 'Be the first to post, or follow more pages.'}
              />
            </div>
          ) : (
            <div className="space-y-3">
              {items.map((post) => <PostCard key={post.id} post={post} />)}
              {list.hasMore
                ? <LoadMoreSentinel onHit={list.loadMore} disabled={list.more} />
                : (
                  <p className="flex items-center justify-center gap-2 py-8 text-center text-sm font-medium text-text-secondary-light dark:text-text-secondary-dark">
                    <CircleCheck size={16} className="text-emerald-500" aria-hidden /> You're all caught up
                  </p>
                )}
            </div>
          )}
        </div>
      </FeedFrame>
      <ReportDialog />
      <EditPostMount pages={pages} />
    </>
  );
};

const SortTab: React.FC<{ active: boolean; onClick: () => void; icon: React.ReactNode; label: string }> = ({ active, onClick, icon, label }) => (
  <button onClick={onClick} className={`flex items-center gap-1.5 rounded-full px-3 py-1 font-semibold transition-colors ${
    active ? 'bg-white text-blue-600 shadow-sm dark:bg-elevated-dark dark:text-blue-300' : 'text-text-secondary-light dark:text-text-secondary-dark'
  }`}>{icon} {label}</button>
);

export { Sparkles };
