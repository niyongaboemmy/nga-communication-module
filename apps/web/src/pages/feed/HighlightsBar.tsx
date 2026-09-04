import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Megaphone, CalendarDays, ChevronRight } from 'lucide-react';
import type { FeedPostView } from '@tupo/shared';
import { useMediaUrl, relativeTime } from './lib';
import * as api from './api';

/**
 * The "stories" analogue, academic flavour: a horizontal snap-scroll of the
 * institution's current announcements and upcoming events. Quiet when there is
 * nothing to highlight.
 */
export const HighlightsBar: React.FC = () => {
  const [items, setItems] = useState<FeedPostView[]>([]);

  useEffect(() => {
    void api.getFeed({ filter: 'announcements' }).then((page) => {
      const events = page.items.filter((p) => p.event && new Date(p.event.startsAt) > new Date());
      const announcements = page.items.filter((p) => p.type === 'announcement');
      setItems([...events, ...announcements].slice(0, 10));
    }).catch(() => {});
  }, []);

  if (!items.length) return null;

  return (
    <div className="feed-hl-scroll -mx-1 flex gap-3 overflow-x-auto px-1 pb-1">
      {items.map((p) => <HighlightCard key={p.id} post={p} />)}
    </div>
  );
};

const HighlightCard: React.FC<{ post: FeedPostView }> = ({ post }) => {
  const cover = post.media.find((m) => m.kind === 'image');
  const coverUrl = useMediaUrl(cover?.fileId);
  const avatar = useMediaUrl(post.page.avatarFileId);
  const isEvent = Boolean(post.event);

  return (
    <Link
      to={`/app/feed/post/${post.id}`}
      className="feed-card-in group relative h-40 w-32 shrink-0 overflow-hidden rounded-2xl border border-border-light bg-gradient-to-br from-blue-600 to-indigo-700 text-white dark:border-border-dark/40"
      style={{ background: coverUrl ? undefined : `linear-gradient(140deg, ${post.page.accent}, #1e293b)` }}
    >
      {coverUrl && <img src={coverUrl} alt="" className="absolute inset-0 h-full w-full object-cover transition-transform duration-300 group-hover:scale-105" />}
      <span className="absolute inset-0 bg-gradient-to-t from-black/75 via-black/10 to-black/30" />
      <span className="absolute left-2 top-2 grid h-8 w-8 place-items-center rounded-full bg-white/90 text-slate-900 ring-2 ring-white/60">
        {avatar ? <img src={avatar} alt="" className="h-full w-full rounded-full object-cover" /> : (isEvent ? <CalendarDays size={15} /> : <Megaphone size={15} />)}
      </span>
      <span className="absolute inset-x-2 bottom-2">
        <span className="mb-0.5 flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-white/80">
          {isEvent ? <><CalendarDays size={10} /> {relativeTime(post.event!.startsAt)}</> : <><Megaphone size={10} /> News</>}
        </span>
        <span className="line-clamp-3 text-xs font-semibold leading-snug">
          {isEvent ? post.event!.title : (post.body || post.page.name)}
        </span>
      </span>
      <ChevronRight size={14} className="absolute right-1.5 top-1/2 -translate-y-1/2 opacity-0 transition-opacity group-hover:opacity-100" />
    </Link>
  );
};
