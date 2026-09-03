import React, { useEffect, useState } from 'react';
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

/** The responsive 3-column frame shared by every Feed screen. */
export const FeedFrame: React.FC<{ left?: React.ReactNode; right?: React.ReactNode; children: React.ReactNode }> = ({
  left, right, children,
}) => (
  <div className="mx-auto flex w-full max-w-[1180px] gap-5 px-3 py-4 sm:px-4">
    {left && <aside className="hidden w-60 shrink-0 lg:block"><div className="sticky top-4 space-y-4">{left}</div></aside>}
    <main className="min-w-0 flex-1">{children}</main>
    {right && <aside className="hidden w-72 shrink-0 xl:block"><div className="sticky top-4 space-y-4">{right}</div></aside>}
  </div>
);

const RailPageRow: React.FC<{ page: FeedPageSummary }> = ({ page }) => {
  const avatar = useMediaUrl(page.avatarFileId);
  return (
    <Link to={`/app/feed/p/${page.slug}`} className="flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-sm transition-colors hover:bg-surface-light dark:hover:bg-card-dark/50">
      <Avatar name={page.name} src={avatar} size={28} />
      <span className="min-w-0 flex-1 truncate font-medium text-text-primary-light dark:text-text-primary-dark">{page.name}</span>
      {page.verified && <BadgeCheck size={13} className="text-blue-500" />}
    </Link>
  );
};

export const LeftRail: React.FC<{ following: FeedPageSummary[] }> = ({ following }) => {
  const { can } = usePermissions();
  const { pathname, search } = useLocation();
  const active = (p: string) => pathname + search === p;
  const Item: React.FC<{ to: string; icon: React.ReactNode; label: string }> = ({ to, icon, label }) => (
    <Link to={to} className={`flex items-center gap-3 rounded-lg px-2.5 py-2 text-sm font-medium transition-colors ${
      active(to) ? 'bg-blue-50 text-blue-600 dark:bg-blue-900/25 dark:text-blue-300' : 'text-text-primary-light hover:bg-surface-light dark:text-text-primary-dark dark:hover:bg-card-dark/50'
    }`}>{icon} {label}</Link>
  );
  return (
    <>
      <nav className="rounded-xl border border-border-light bg-card-light p-1.5 dark:border-border-dark/40 dark:bg-elevated-dark/40">
        <Item to="/app/feed" icon={<Newspaper size={17} />} label="Home" />
        <Item to="/app/feed?filter=following" icon={<TrendingUp size={17} />} label="Following" />
        <Item to="/app/feed?filter=announcements" icon={<Megaphone size={17} />} label="Announcements" />
        <Item to="/app/feed/saved" icon={<Bookmark size={17} />} label="Saved" />
        <Item to="/app/feed/pages" icon={<LayoutGrid size={17} />} label="All pages" />
        {can(['MODERATION_QUEUE_VIEW']) && <Item to="/app/feed/moderation" icon={<ShieldAlert size={17} />} label="Moderation" />}
      </nav>
      {following.length > 0 && (
        <div className="rounded-xl border border-border-light bg-card-light p-2 dark:border-border-dark/40 dark:bg-elevated-dark/40">
          <p className="px-2 pb-1 pt-1 text-[11px] font-semibold uppercase tracking-wide text-text-secondary-light dark:text-text-secondary-dark">Your pages</p>
          {following.slice(0, 8).map((p) => <RailPageRow key={p.id} page={p} />)}
        </div>
      )}
    </>
  );
};

export const RightRail: React.FC<{ suggestions: FeedPageSummary[]; onFollow: (id: string) => void }> = ({ suggestions, onFollow }) => {
  const { can } = usePermissions();
  return (
    <>
      {suggestions.length > 0 && (
        <div className="rounded-xl border border-border-light bg-card-light p-3 dark:border-border-dark/40 dark:bg-elevated-dark/40">
          <p className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-text-secondary-light dark:text-text-secondary-dark">
            <Sparkles size={13} /> Discover pages
          </p>
          <div className="space-y-2">
            {suggestions.slice(0, 5).map((p) => (
              <div key={p.id} className="flex items-center gap-2">
                <RailPageRow page={p} />
                <button onClick={() => onFollow(p.id)} className="ml-auto shrink-0 rounded-full border border-blue-500 px-2.5 py-1 text-[11px] font-semibold text-blue-600 hover:bg-blue-50 dark:text-blue-400 dark:hover:bg-blue-900/20">
                  Follow
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
      {can(['FEED_PAGE_MANAGE']) && (
        <Link to="/app/feed/pages" className="flex items-center justify-center gap-2 rounded-xl border border-dashed border-border-light p-3 text-sm font-semibold text-text-secondary-light transition-colors hover:border-blue-400 hover:text-blue-600 dark:border-border-dark/50 dark:text-text-secondary-dark">
          <Plus size={16} /> Create a page
        </Link>
      )}
      <p className="px-3 text-[11px] leading-relaxed text-text-secondary-light/80 dark:text-text-secondary-dark/70">
        Tupo Feed · Nyanza Green Academy. Be kind, stay on topic, and report anything that breaks the rules.
      </p>
    </>
  );
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
  <div className="feed-skeleton rounded-2xl border border-border-light bg-card-light p-4 dark:border-border-dark/40 dark:bg-elevated-dark/40">
    <div className="flex gap-3">
      <div className="h-10 w-10 rounded-full bg-slate-200 dark:bg-card-dark" />
      <div className="flex-1 space-y-2">
        <div className="h-3 w-1/3 rounded bg-slate-200 dark:bg-card-dark" />
        <div className="h-2.5 w-1/4 rounded bg-slate-200 dark:bg-card-dark" />
      </div>
    </div>
    <div className="mt-4 space-y-2">
      <div className="h-3 w-full rounded bg-slate-200 dark:bg-card-dark" />
      <div className="h-3 w-4/5 rounded bg-slate-200 dark:bg-card-dark" />
      <div className="h-48 w-full rounded-xl bg-slate-200 dark:bg-card-dark" />
    </div>
  </div>
);

export { PostCard };
