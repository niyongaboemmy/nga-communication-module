import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ArrowUp, Clock, Flame, Sparkles } from 'lucide-react';
import type { FeedFilter, FeedPageSummary, FeedPostView, FeedSort } from '@tupo/shared';
import { EmptyState } from '../../components/ui';
import { useFeed, useFeedList } from './FeedProvider';
import { FeedFrame, LeftRail, RightRail, ReportDialog, EditPostMount, PostSkeleton, PostCard } from './Frame';
import { Composer } from './Composer';
import { HighlightsBar } from './HighlightsBar';
import * as api from './api';

export const FeedHome: React.FC = () => {
  const [params, setParams] = useSearchParams();
  const filter = (params.get('filter') as FeedFilter) || 'all';
  const [sort, setSort] = useState<FeedSort>('recent');
  const [pages, setPages] = useState<FeedPageSummary[]>([]);
  const { posts, ingest, currentUserId } = useFeed();
  const [pendingTop, setPendingTop] = useState<FeedPostView[]>([]);

  useEffect(() => { void api.listPages().then(setPages); }, []);

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

  const following = useMemo(() => pages.filter((p) => p.following), [pages]);
  const suggestions = useMemo(() => pages.filter((p) => !p.following && !p.mandatory), [pages]);

  const follow = async (id: string) => {
    const updated = await api.followPage(id);
    setPages((prev) => prev.map((p) => (p.id === id ? updated : p)));
  };

  const items = list.ids.map((id) => posts[id]).filter((p): p is FeedPostView => Boolean(p));

  return (
    <>
      <FeedFrame left={<LeftRail following={following} />} right={<RightRail suggestions={suggestions} onFollow={follow} />}>
        <div className="space-y-4">
          <HighlightsBar />
          <Composer pages={pages} onPublished={(post) => { if (post) { list.prepend(post.id); ingest([post]); } }} />

          <div className="flex items-center gap-1 rounded-full border border-border-light bg-card-light p-1 text-sm dark:border-border-dark/40 dark:bg-elevated-dark/40">
            <SortTab active={sort === 'recent'} onClick={() => setSort('recent')} icon={<Clock size={14} />} label="Latest" />
            <SortTab active={sort === 'top'} onClick={() => setSort('top')} icon={<Flame size={14} />} label="Top" />
            <span className="flex-1" />
            {filter !== 'all' && (
              <button onClick={() => setParams({})} className="rounded-full px-3 py-1 text-xs font-medium capitalize text-blue-600 dark:text-blue-400">
                {filter} ✕
              </button>
            )}
          </div>

          {pendingTop.length > 0 && (
            <button onClick={showPending} className="feed-live-ping mx-auto flex items-center gap-1.5 rounded-full bg-blue-600 px-4 py-1.5 text-xs font-semibold text-white shadow-lg">
              <ArrowUp size={13} /> {pendingTop.length} new {pendingTop.length === 1 ? 'post' : 'posts'}
            </button>
          )}

          {list.loading ? (
            <><PostSkeleton /><PostSkeleton /></>
          ) : list.error ? (
            <EmptyState title="Could not load the feed" hint={list.error} />
          ) : items.length === 0 ? (
            <EmptyState
              title={filter === 'following' ? 'Nothing from your pages yet' : 'The feed is quiet'}
              hint={filter === 'following' ? 'Follow a few more pages to fill this up.' : 'Be the first to post, or follow more pages.'}
            />
          ) : (
            <div className="space-y-4">
              {items.map((post) => <PostCard key={post.id} post={post} />)}
              {list.hasMore && (
                <button onClick={list.loadMore} disabled={list.more}
                  className="mx-auto block rounded-full border border-border-light px-5 py-2 text-sm font-semibold text-text-secondary-light hover:bg-surface-light dark:border-border-dark/50 dark:text-text-secondary-dark">
                  {list.more ? 'Loading…' : 'Load more'}
                </button>
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
  <button onClick={onClick} className={`flex items-center gap-1.5 rounded-full px-3 py-1.5 font-semibold transition-colors ${
    active ? 'bg-blue-600 text-white' : 'text-text-secondary-light hover:bg-surface-light dark:text-text-secondary-dark dark:hover:bg-card-dark/50'
  }`}>{icon} {label}</button>
);

export { Sparkles };
