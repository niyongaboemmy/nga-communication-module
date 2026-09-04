import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import {
  Sparkles, Bookmark, ShieldAlert, LayoutGrid, Newspaper, Megaphone, TrendingUp,
  Plus, BadgeCheck,
} from 'lucide-react';
import type { FeedPageSummary, FeedPostView, FeedReportReason } from '@tupo/shared';
import { FEED_REPORT_REASONS } from '@tupo/shared';
import { Avatar } from '../../components/ui';
import { usePermissions } from '../../hooks/usePermissions';
import { useMediaUrl } from './lib';
import { Composer } from './Composer';
import { PostCard } from './PostCard';
import { useFeed } from './FeedProvider';
import * as api from './api';
import './feed.css';

/**
 * The Facebook shell: an edge-to-edge grey canvas with a fixed-width feed
 * column visually centred, and sticky sidebars pinned to the window edges that
 * drop away as the viewport narrows.
 *
 *   < 1100px   right rail hidden
 *   <  980px   left rail hidden, feed centred, cards go full-bleed on phones
 */
export const FeedFrame: React.FC<{ left?: React.ReactNode; right?: React.ReactNode; children: React.ReactNode }> = ({
  left, right, children,
}) => (
  <div className="feed-canvas w-full">
    <div className="mx-auto flex w-full justify-center gap-0 sm:gap-4 sm:px-4 sm:py-5 lg:max-w-[1280px] lg:justify-between lg:gap-5 xl:max-w-[1400px]">
      {left && (
        <aside className="feed-rail hidden w-[264px] shrink-0 self-start lg:block xl:w-[300px]">
          <div className="sticky top-5 max-h-[calc(100dvh-92px)] space-y-3 overflow-y-auto overflow-x-hidden pb-6 pr-1">{left}</div>
        </aside>
      )}
      <main className="w-full min-w-0 max-w-[600px] shrink-0 sm:mx-auto">{children}</main>
      {right && (
        <aside className="feed-rail hidden w-[264px] shrink-0 self-start xl:block xl:w-[300px]">
          <div className="sticky top-5 max-h-[calc(100dvh-92px)] space-y-3 overflow-y-auto overflow-x-hidden pb-6 pl-1">{right}</div>
        </aside>
      )}
    </div>
  </div>
);

/** Auto-loads the next page when the reader nears the bottom (FB infinite scroll). */
export const LoadMoreSentinel: React.FC<{ onHit: () => void; disabled?: boolean }> = ({ onHit, disabled }) => {
  const ref = useRef<HTMLDivElement>(null);
  const cb = useRef(onHit);
  cb.current = onHit;
  useEffect(() => {
    if (disabled || !ref.current) return;
    const io = new IntersectionObserver((e) => { if (e[0]?.isIntersecting) cb.current(); }, { rootMargin: '800px' });
    io.observe(ref.current);
    return () => io.disconnect();
  }, [disabled]);
  return (
    <div ref={ref} className="flex justify-center py-6" aria-hidden>
      {!disabled && <span className="h-6 w-6 animate-spin rounded-full border-2 border-blue-500 border-t-transparent" />}
    </div>
  );
};

const RailPageRow: React.FC<{ page: FeedPageSummary }> = ({ page }) => {
  const avatar = useMediaUrl(page.avatarFileId);
  return (
    <Link to={`/app/feed/p/${page.slug}`} className="flex min-w-0 flex-1 items-center gap-2.5 rounded-lg px-2 py-1.5 text-sm transition-colors hover:bg-black/5 dark:hover:bg-white/5">
      <Avatar name={page.name} src={avatar} size={30} />
      <span className="min-w-0 flex-1 truncate font-medium text-text-primary-light dark:text-text-primary-dark">{page.name}</span>
      {page.verified && <BadgeCheck size={13} className="shrink-0 text-blue-500" />}
    </Link>
  );
};

export const LeftRail: React.FC<{ following: FeedPageSummary[] }> = ({ following }) => {
  const { can } = usePermissions();
  const { pathname, search } = useLocation();
  const active = (p: string) => pathname + search === p;
  const Item: React.FC<{ to: string; icon: React.ReactNode; label: string; tint?: string }> = ({ to, icon, label, tint }) => (
    <Link to={to} className={`flex items-center gap-3 rounded-lg px-2 py-2 text-[15px] font-medium transition-colors ${
      active(to) ? 'bg-blue-50 text-blue-700 dark:bg-blue-900/25 dark:text-blue-300' : 'text-text-primary-light hover:bg-black/5 dark:text-text-primary-dark dark:hover:bg-white/5'
    }`}>
      <span className={`grid h-9 w-9 shrink-0 place-items-center rounded-full dark:bg-white/6 ${tint ?? 'bg-surface-light'}`}>{icon}</span>
      {label}
    </Link>
  );
  return (
    <>
      <nav className="space-y-0.5">
        <Item to="/app/feed" icon={<Newspaper size={19} className="text-blue-600 dark:text-blue-400" />} label="Home" tint="bg-[#e7f0ff]" />
        <Item to="/app/feed?filter=following" icon={<TrendingUp size={19} className="text-emerald-600 dark:text-emerald-400" />} label="Following" tint="bg-[#e6f6ee]" />
        <Item to="/app/feed?filter=announcements" icon={<Megaphone size={19} className="text-orange-600 dark:text-orange-400" />} label="Announcements" tint="bg-[#fdeee0]" />
        <Item to="/app/feed/saved" icon={<Bookmark size={19} className="text-violet-600 dark:text-violet-400" />} label="Saved" tint="bg-[#efe9fb]" />
        <Item to="/app/feed/pages" icon={<LayoutGrid size={19} className="text-sky-600 dark:text-sky-400" />} label="Pages" tint="bg-[#e4f2fb]" />
        {can(['MODERATION_QUEUE_VIEW']) && <Item to="/app/feed/moderation" icon={<ShieldAlert size={19} className="text-rose-600 dark:text-rose-400" />} label="Moderation" tint="bg-[#fce8ec]" />}
      </nav>
      {following.length > 0 && (
        <>
          <div className="mx-2 my-1 border-t border-black/10 dark:border-white/10" />
          <p className="px-2 pb-1 text-[13px] font-semibold text-text-secondary-light dark:text-text-secondary-dark">Your pages</p>
          <div className="space-y-0.5">{following.slice(0, 10).map((p) => <div key={p.id} className="flex"><RailPageRow page={p} /></div>)}</div>
        </>
      )}
    </>
  );
};

export const RightRail: React.FC<{ suggestions: FeedPageSummary[]; onFollow: (id: string) => void }> = ({ suggestions, onFollow }) => {
  const { can } = usePermissions();
  return (
    <>
      {suggestions.length > 0 && (
        <div>
          <div className="mb-1 flex items-center justify-between px-2">
            <p className="flex items-center gap-1.5 text-[15px] font-semibold text-text-secondary-light dark:text-text-secondary-dark">
              <Sparkles size={15} /> Suggested pages
            </p>
            <Link to="/app/feed/pages" className="text-[13px] font-medium text-blue-600 hover:underline dark:text-blue-400">See all</Link>
          </div>
          <div className="space-y-0.5">
            {suggestions.slice(0, 6).map((p) => (
              <div key={p.id} className="flex items-center gap-1">
                <RailPageRow page={p} />
                <button onClick={() => onFollow(p.id)} className="shrink-0 rounded-md bg-blue-50 px-2.5 py-1.5 text-[13px] font-semibold text-blue-600 transition-colors hover:bg-blue-100 dark:bg-blue-900/25 dark:text-blue-300 dark:hover:bg-blue-900/40">
                  Follow
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
      {can(['FEED_PAGE_MANAGE']) && (
        <Link to="/app/feed/pages" className="flex items-center justify-center gap-2 rounded-lg border border-dashed border-black/15 p-3 text-sm font-semibold text-text-secondary-light transition-colors hover:border-blue-400 hover:text-blue-600 dark:border-white/15 dark:text-text-secondary-dark">
          <Plus size={16} /> Create a page
        </Link>
      )}
      <p className="px-2 text-[12px] leading-relaxed text-text-secondary-light/80 dark:text-text-secondary-dark/70">
        Tupo Feed · Nyanza Green Academy. Be kind, stay on topic, and report anything that breaks the rules.
      </p>
    </>
  );
};

/**
 * Every Feed screen needs the same left/right rails so the section nav
 * (Home/Following/Announcements/Saved/Pages/Moderation) never disappears
 * just because a screen is Saved, a page profile, or the moderation queue
 * rather than the Home feed itself. Centralised here so a new screen can't
 * forget to wire it up the way Saved/Moderation/PageDirectory once did.
 */
export const useFeedRails = () => {
  const [pages, setPages] = useState<FeedPageSummary[]>([]);
  useEffect(() => { void api.listPages().then(setPages); }, []);
  const following = useMemo(() => pages.filter((p) => p.following), [pages]);
  const suggestions = useMemo(() => pages.filter((p) => !p.following && !p.mandatory), [pages]);
  const follow = useCallback(async (id: string) => {
    const updated = await api.followPage(id);
    setPages((prev) => prev.map((p) => (p.id === id ? updated : p)));
  }, []);
  return {
    pages, following, suggestions, follow,
    left: <LeftRail following={following} />,
    right: <RightRail suggestions={suggestions} onFollow={follow} />,
  };
};

/** Global report dialog — opened by a `feed:report` window event from any card. */
export const ReportDialog: React.FC = () => {
  const [target, setTarget] = useState<{ type: 'post' | 'comment'; id: string } | null>(null);
  const [reason, setReason] = useState<FeedReportReason>('spam');
  const [note, setNote] = useState('');
  const [done, setDone] = useState(false);

  useEffect(() => {
    const open = (e: Event) => { setTarget((e as CustomEvent).detail); setDone(false); setReason('spam'); setNote(''); };
    window.addEventListener('feed:report', open);
    return () => window.removeEventListener('feed:report', open);
  }, []);

  if (!target) return null;
  const submit = async () => {
    if (target.type === 'post') await api.reportPost(target.id, reason, note);
    else await api.reportComment(target.id, reason, note);
    setDone(true);
    setTimeout(() => setTarget(null), 1400);
  };
  return (
    <div className="fixed inset-0 z-[110] grid place-items-center bg-black/50 p-4" onClick={() => setTarget(null)}>
      <div className="w-full max-w-sm animate-pop rounded-2xl border border-border-light bg-white p-5 dark:border-border-dark/50 dark:bg-elevated-dark" onClick={(e) => e.stopPropagation()}>
        {done ? (
          <p className="py-6 text-center text-sm font-medium text-text-primary-light dark:text-text-primary-dark">Thanks — a moderator will review this.</p>
        ) : (
          <>
            <h2 className="text-sm font-semibold text-text-primary-light dark:text-text-primary-dark">Report this {target.type}</h2>
            <div className="mt-3 space-y-1.5">
              {FEED_REPORT_REASONS.map((r) => (
                <label key={r} className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm capitalize hover:bg-surface-light dark:hover:bg-card-dark/50">
                  <input type="radio" name="reason" checked={reason === r} onChange={() => setReason(r)} />
                  {r.replace('_', ' ')}
                </label>
              ))}
            </div>
            <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} placeholder="Add context (optional)"
              className="mt-2 w-full resize-none rounded-lg border border-border-light bg-surface-light px-2.5 py-1.5 text-sm dark:border-border-dark/60 dark:bg-card-dark/50" />
            <div className="mt-3 flex justify-end gap-2">
              <button onClick={() => setTarget(null)} className="rounded-full px-3 py-1.5 text-sm text-text-secondary-light dark:text-text-secondary-dark">Cancel</button>
              <button onClick={() => void submit()} className="rounded-full bg-red-600 px-4 py-1.5 text-sm font-semibold text-white hover:bg-red-700">Report</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
};

/** Global edit-post modal — opened by a `feed:edit` window event. */
export const EditPostMount: React.FC<{ pages: FeedPageSummary[] }> = ({ pages }) => {
  const { patch } = useFeed();
  const [post, setPost] = useState<FeedPostView | null>(null);
  useEffect(() => {
    const open = async (e: Event) => {
      const id = (e as CustomEvent).detail as string;
      try { setPost(await api.getPost(id)); } catch { /* gone */ }
    };
    window.addEventListener('feed:edit', open);
    return () => window.removeEventListener('feed:edit', open);
  }, []);
  if (!post) return null;
  return (
    <Composer
      pages={pages}
      editing={post}
      onClose={() => setPost(null)}
      onPublished={(updated) => { if (updated) patch(updated.id, updated); setPost(null); }}
    />
  );
};

/** Skeleton shown while the first page loads. */
export const PostSkeleton: React.FC = () => (
  <div className="feed-card feed-skeleton p-4">
    <div className="flex gap-3">
      <div className="h-10 w-10 rounded-full bg-black/10 dark:bg-white/10" />
      <div className="flex-1 space-y-2 pt-1">
        <div className="h-3 w-1/3 rounded bg-black/10 dark:bg-white/10" />
        <div className="h-2.5 w-1/4 rounded bg-black/10 dark:bg-white/10" />
      </div>
    </div>
    <div className="mt-4 space-y-2">
      <div className="h-3 w-full rounded bg-black/10 dark:bg-white/10" />
      <div className="h-3 w-4/5 rounded bg-black/10 dark:bg-white/10" />
      <div className="mt-3 h-56 w-full rounded-lg bg-black/10 dark:bg-white/10" />
    </div>
  </div>
);

export { PostCard };
