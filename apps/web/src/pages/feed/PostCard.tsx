import React, { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  MessageCircle, Share2, Bookmark, MoreHorizontal, Megaphone, Pin, BadgeCheck,
  Pencil, Trash2, Flag, EyeOff, Link2, Globe, Users2,
} from 'lucide-react';
import type { FeedPostView, FeedReaction } from '@tupo/shared';
import { FEED_REACTION_META } from '@tupo/shared';
import { Avatar } from '../../components/ui';
import { useFeed } from './FeedProvider';
import { MediaGallery } from './MediaGallery';
import { PollBlock, EventBlock } from './PollEventBlocks';
import { Comments } from './Comments';
import { EmojiBurst, ReactionPicker, relativeTime, renderRichText, useMediaUrl, usePressToOpen } from './lib';
import * as api from './api';

const AUDIENCE_META: Record<string, { icon: React.ReactNode; label: string }> = {
  everyone: { icon: <Globe size={11} />, label: 'Everyone' },
  staff: { icon: <Users2 size={11} />, label: 'Staff' },
  students: { icon: <Users2 size={11} />, label: 'Students' },
  parents: { icon: <Users2 size={11} />, label: 'Parents' },
};

export const PostCard: React.FC<{ post: FeedPostView; openComments?: boolean; permalink?: boolean }> = ({
  post, openComments = false, permalink = false,
}) => {
  const { react, toggleBookmark, currentUserId } = useFeed();
  const [showComments, setShowComments] = useState(openComments);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [burst, setBurst] = useState<{ emoji: string; seed: number } | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [menu, setMenu] = useState(false);
  const cardRef = useRef<HTMLElement>(null);
  const viewed = useRef(false);
  const avatarUrl = useMediaUrl(post.page.avatarFileId);

  // Record an impression once the card is properly on screen (FR-FEED-10).
  useEffect(() => {
    const el = cardRef.current;
    if (!el || viewed.current) return;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting && e.intersectionRatio > 0.5) && !viewed.current) {
        viewed.current = true;
        void api.recordView(post.id);
        io.disconnect();
      }
    }, { threshold: [0.5] });
    io.observe(el);
    return () => io.disconnect();
  }, [post.id]);

  const doReact = (emoji: FeedReaction) => {
    setPickerOpen(false);
    if (post.reactions.mine !== emoji) setBurst({ emoji: FEED_REACTION_META[emoji].emoji, seed: Date.now() });
    void react(post.id, emoji);
  };

  const primaryReaction: FeedReaction = post.reactions.mine ?? 'like';
  const press = usePressToOpen(() => setPickerOpen(true));

  const share = async () => {
    const url = `${location.origin}/app/feed/post/${post.id}`;
    try {
      if (navigator.share) await navigator.share({ url, title: `${post.page.name} on Tupo` });
      else await navigator.clipboard.writeText(url);
      await api.sharePost(post.id);
    } catch { /* user dismissed */ }
  };

  const clamp = !expanded && post.body.length > 360;
  const bodyText = clamp ? `${post.body.slice(0, 340).trimEnd()}…` : post.body;

  return (
    <article
      ref={cardRef}
      className="feed-card-in overflow-hidden rounded-2xl border border-border-light bg-card-light dark:border-border-dark/40 dark:bg-elevated-dark/50"
    >
      {(post.pinned || post.type === 'announcement') && (
        <div className="flex items-center gap-1.5 border-b border-border-light bg-blue-50/60 px-4 py-1.5 text-[11px] font-semibold text-blue-700 dark:border-border-dark/40 dark:bg-blue-900/20 dark:text-blue-300">
          {post.type === 'announcement' ? <Megaphone size={12} /> : <Pin size={12} />}
          {post.type === 'announcement' ? 'Announcement' : 'Pinned'}
        </div>
      )}

      <header className="flex items-start gap-3 px-4 pt-3">
        <Link to={`/app/feed/p/${post.page.slug}`}>
          <Avatar name={post.page.name} src={avatarUrl} size={42} />
        </Link>
        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-center gap-1 text-sm leading-tight">
            <Link to={`/app/feed/p/${post.page.slug}`} className="font-semibold text-text-primary-light hover:underline dark:text-text-primary-dark">
              {post.page.name}
            </Link>
            {post.page.verified && <BadgeCheck size={14} className="text-blue-500" aria-label="Verified" />}
          </p>
          <p className="flex items-center gap-1.5 text-xs text-text-secondary-light dark:text-text-secondary-dark">
            <Link to={`/app/feed/post/${post.id}`} className="hover:underline">{relativeTime(post.publishedAt ?? post.createdAt)}</Link>
            <span aria-hidden>·</span>
            <span className="flex items-center gap-0.5">{AUDIENCE_META[post.audience]?.icon} {AUDIENCE_META[post.audience]?.label}</span>
            {post.editedAt && <><span aria-hidden>·</span><span>edited</span></>}
            {post.author.name && <span className="hidden sm:inline">· by {post.author.name}</span>}
          </p>
        </div>
        <div className="relative">
          <button onClick={() => setMenu((v) => !v)} aria-label="Post actions" className="grid h-8 w-8 place-items-center rounded-full text-text-secondary-light hover:bg-surface-light dark:hover:bg-card-dark">
            <MoreHorizontal size={18} />
          </button>
          {menu && (
            <div className="animate-pop absolute right-0 top-full z-20 mt-1 w-48 rounded-xl border border-border-light bg-white p-1 shadow-xl dark:border-border-dark/60 dark:bg-elevated-dark" onMouseLeave={() => setMenu(false)}>
              <MenuItem icon={<Link2 size={14} />} label="Copy link" onClick={() => { void navigator.clipboard.writeText(`${location.origin}/app/feed/post/${post.id}`); setMenu(false); }} />
              <MenuItem icon={<Bookmark size={14} />} label={post.bookmarked ? 'Remove from saved' : 'Save post'} onClick={() => { void toggleBookmark(post.id); setMenu(false); }} />
              {post.canEdit && <MenuItem icon={<Pencil size={14} />} label="Edit post" onClick={() => { setMenu(false); window.dispatchEvent(new CustomEvent('feed:edit', { detail: post.id })); }} />}
              {post.canEdit && <MenuItem icon={<EyeOff size={14} />} label="Unpublish" onClick={() => { void api.unpublishPost(post.id); setMenu(false); }} />}
              {(post.canEdit || post.canModerate) && <MenuItem danger icon={<Trash2 size={14} />} label="Delete post" onClick={() => { if (confirm('Delete this post?')) void api.deletePost(post.id); setMenu(false); }} />}
              {post.author.id !== currentUserId && <MenuItem icon={<Flag size={14} />} label="Report post" onClick={() => { setMenu(false); window.dispatchEvent(new CustomEvent('feed:report', { detail: { type: 'post', id: post.id } })); }} />}
            </div>
          )}
        </div>
      </header>

      {post.body && (
        <div className="px-4 pt-2 text-[15px] leading-relaxed text-text-primary-light dark:text-text-primary-dark">
          <p className="whitespace-pre-wrap break-words">{renderRichText(bodyText)}</p>
          {clamp && (
            <button onClick={() => setExpanded(true)} className="mt-0.5 text-sm font-semibold text-text-secondary-light hover:underline dark:text-text-secondary-dark">
              See more
            </button>
          )}
        </div>
      )}

      <div className="px-4">
        {post.media.length > 0 && <MediaGallery media={post.media} />}
        {post.poll && <PollBlock postId={post.id} poll={post.poll} />}
        {post.event && <EventBlock postId={post.id} event={post.event} />}
        {post.linkPreview && <LinkPreview preview={post.linkPreview} />}
      </div>

      {/* Engagement summary */}
      {(post.reactions.total > 0 || post.commentCount > 0 || post.shareCount > 0) && (
        <div className="mt-3 flex items-center justify-between px-4 text-xs text-text-secondary-light dark:text-text-secondary-dark">
          <div className="flex items-center gap-1">
            {post.reactions.top.length > 0 && (
              <span className="flex -space-x-1">
                {post.reactions.top.map((r) => (
                  <span key={r} className="grid h-4 w-4 place-items-center rounded-full bg-white text-[10px] ring-1 ring-border-light dark:bg-elevated-dark dark:ring-border-dark/60">
                    {FEED_REACTION_META[r].emoji}
                  </span>
                ))}
              </span>
            )}
            {post.reactions.total > 0 && (
              <span className="feed-count-tick" key={post.reactions.total}>
                {reactionLabel(post)}
              </span>
            )}
          </div>
          <div className="flex gap-3">
            {post.commentCount > 0 && <button onClick={() => setShowComments(true)} className="hover:underline">{post.commentCount} {post.commentCount === 1 ? 'comment' : 'comments'}</button>}
            {post.shareCount > 0 && <span>{post.shareCount} {post.shareCount === 1 ? 'share' : 'shares'}</span>}
          </div>
        </div>
      )}

      {/* Action bar */}
      <div className="mt-1.5 flex items-stretch gap-1 border-t border-border-light px-2 py-1 dark:border-border-dark/40">
        <div className="relative flex-1" {...press} onMouseLeave={() => setPickerOpen(false)}>
          {pickerOpen && <ReactionPicker onPick={doReact} onClose={() => setPickerOpen(false)} />}
          <button
            onClick={() => doReact(primaryReaction)}
            className={`relative flex w-full items-center justify-center gap-1.5 rounded-lg py-2 text-sm font-semibold transition-colors ${
              post.reactions.mine
                ? 'text-blue-600 dark:text-blue-400'
                : 'text-text-secondary-light hover:bg-surface-light dark:text-text-secondary-dark dark:hover:bg-card-dark/60'
            }`}
            style={post.reactions.mine ? { color: FEED_REACTION_META[post.reactions.mine].tint } : undefined}
          >
            {burst && <EmojiBurst emoji={burst.emoji} seed={burst.seed} />}
            <span className="text-base leading-none">{post.reactions.mine ? FEED_REACTION_META[post.reactions.mine].emoji : '👍'}</span>
            {post.reactions.mine ? FEED_REACTION_META[post.reactions.mine].label : 'Like'}
          </button>
        </div>
        <button
          onClick={() => setShowComments((v) => !v)}
          disabled={post.commentPolicy === 'closed' && !post.canComment}
          className="flex flex-1 items-center justify-center gap-1.5 rounded-lg py-2 text-sm font-semibold text-text-secondary-light transition-colors hover:bg-surface-light disabled:opacity-40 dark:text-text-secondary-dark dark:hover:bg-card-dark/60"
        >
          <MessageCircle size={17} /> Comment
        </button>
        <button onClick={() => void share()} className="flex flex-1 items-center justify-center gap-1.5 rounded-lg py-2 text-sm font-semibold text-text-secondary-light transition-colors hover:bg-surface-light dark:text-text-secondary-dark dark:hover:bg-card-dark/60">
          <Share2 size={16} /> Share
        </button>
        <button
          onClick={() => void toggleBookmark(post.id)}
          aria-label={post.bookmarked ? 'Remove from saved' : 'Save'}
          className={`grid w-11 place-items-center rounded-lg transition-colors hover:bg-surface-light dark:hover:bg-card-dark/60 ${post.bookmarked ? 'text-blue-600 dark:text-blue-400' : 'text-text-secondary-light dark:text-text-secondary-dark'}`}
        >
          <Bookmark size={17} className={post.bookmarked ? 'fill-current' : ''} />
        </button>
      </div>

      {(showComments || permalink) && <Comments post={post} autoFocus={showComments && !permalink} />}
    </article>
  );
};

function reactionLabel(post: FeedPostView): string {
  const total = post.reactions.total;
  if (post.reactions.mine && total === 1) return 'You';
  if (post.reactions.mine) return `You and ${total - 1} ${total - 1 === 1 ? 'other' : 'others'}`;
  return String(total);
}

const MenuItem: React.FC<{ icon: React.ReactNode; label: string; onClick: () => void; danger?: boolean }> = ({ icon, label, onClick, danger }) => (
  <button
    onClick={onClick}
    className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm transition-colors ${
      danger ? 'text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20' : 'text-text-primary-light hover:bg-surface-light dark:text-text-primary-dark dark:hover:bg-card-dark'
    }`}
  >
    {icon} {label}
  </button>
);

const LinkPreview: React.FC<{ preview: NonNullable<FeedPostView['linkPreview']> }> = ({ preview }) => (
  <a href={preview.url} target="_blank" rel="noopener noreferrer nofollow"
    className="mt-3 flex overflow-hidden rounded-xl border border-border-light transition-colors hover:bg-surface-light dark:border-border-dark/50 dark:hover:bg-card-dark/40">
    {preview.image && <img src={preview.image} alt="" className="h-24 w-24 shrink-0 object-cover sm:h-28 sm:w-40" loading="lazy" />}
    <div className="min-w-0 flex-1 p-3">
      <p className="text-[11px] uppercase tracking-wide text-text-secondary-light dark:text-text-secondary-dark">{preview.siteName ?? new URL(preview.url).hostname}</p>
      <p className="truncate text-sm font-semibold text-text-primary-light dark:text-text-primary-dark">{preview.title ?? preview.url}</p>
      {preview.description && <p className="mt-0.5 line-clamp-2 text-xs text-text-secondary-light dark:text-text-secondary-dark">{preview.description}</p>}
    </div>
  </a>
);
