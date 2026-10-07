import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  MessageCircle, Share2, Bookmark, MoreHorizontal, Megaphone, Pin, BadgeCheck,
  Pencil, Trash2, Flag, EyeOff, Link2, Globe, Users2,
} from 'lucide-react';
import type { FeedPostView, FeedReaction } from '@tupo/shared';
import { FEED_REACTION_META } from '@tupo/shared';
import { Avatar } from '../../components/ui';
import { useNotify } from '../../context/NotificationContext';
import { useFeed } from './FeedProvider';
import { MediaGallery } from './MediaGallery';
import { PollBlock, EventBlock } from './PollEventBlocks';
import { Comments } from './Comments';
import {
  ReactionBurst, ReactionBubbles, ReactionIcon, ReactionPicker, fullTime, relativeTime,
  renderRichText, useDismiss, useMediaUrl, usePressToOpen,
} from './lib';
import * as api from './api';

const AUDIENCE_META: Record<string, { icon: React.ReactNode; label: string }> = {
  everyone: { icon: <Globe size={12} />, label: 'Everyone' },
  staff: { icon: <Users2 size={12} />, label: 'Staff' },
  students: { icon: <Users2 size={12} />, label: 'Students' },
  parents: { icon: <Users2 size={12} />, label: 'Parents' },
};

export const PostCard: React.FC<{ post: FeedPostView; openComments?: boolean; permalink?: boolean }> = ({
  post, openComments = false, permalink = false,
}) => {
  const { react, toggleBookmark, currentUserId, patch } = useFeed();
  // Renamed on the way in: `confirm` from useNotify is a toast, not the
  // native confirm() dialog the Delete-post handler below still needs.
  const { confirm: toastConfirm, notify } = useNotify();
  const [showComments, setShowComments] = useState(openComments);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [burst, setBurst] = useState<{ reaction: FeedReaction; seed: number } | null>(null);
  const [thumbPop, setThumbPop] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const [menu, setMenu] = useState(false);
  const closeMenu = useCallback(() => setMenu(false), []);
  const menuRef = useDismiss(menu, closeMenu);
  const cardRef = useRef<HTMLElement>(null);
  const viewed = useRef(false);
  const avatarUrl = useMediaUrl(post.page.avatarFileId);

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
    if (post.reactions.mine !== emoji) {
      setBurst({ reaction: emoji, seed: Date.now() });
      setThumbPop((n) => n + 1);
    }
    void react(post.id, emoji);
  };

  const primaryReaction: FeedReaction = post.reactions.mine ?? 'like';
  const press = usePressToOpen(() => setPickerOpen(true), () => setPickerOpen(false));

  const share = async () => {
    const url = `${location.origin}/app/feed/post/${post.id}`;
    if (navigator.share) {
      // The OS share sheet is its own feedback — cancelling it (the common
      // case for the rejection here) needs no toast on top of it.
      try { await navigator.share({ url, title: `${post.page.name} on Tupo` }); } catch { return; }
    } else {
      // Unlike the share sheet, a clipboard write is invisible — with no
      // confirmation this looked exactly like the button doing nothing.
      try { await navigator.clipboard.writeText(url); } catch { notify({ title: 'Could not copy the link', tone: 'error' }); return; }
      toastConfirm('Link copied');
    }
    void api.sharePost(post.id).catch(() => {});
  };

  const clamp = !expanded && post.body.length > 360;
  const bodyText = clamp ? `${post.body.slice(0, 340).trimEnd()}…` : post.body;
  const mineTint = post.reactions.mine ? FEED_REACTION_META[post.reactions.mine].tint : undefined;

  return (
    <article ref={cardRef} className={`feed-card feed-card-in relative ${menu ? 'z-20' : ''}`}>
      {(post.pinned || post.type === 'announcement') && (
        <div className="flex items-center gap-1.5 border-b border-black/5 bg-blue-50/70 px-4 py-1.5 text-[11px] font-semibold text-blue-700 dark:border-white/5 dark:bg-blue-900/20 dark:text-blue-300">
          {post.type === 'announcement' ? <Megaphone size={12} /> : <Pin size={12} />}
          {post.type === 'announcement' ? 'Announcement' : 'Pinned post'}
        </div>
      )}

      <header className="flex items-start gap-2.5 px-3 pt-3 sm:px-4">
        <Link to={`/app/feed/p/${post.page.slug}`} className="shrink-0">
          <Avatar name={post.page.name} src={avatarUrl} size={40} />
        </Link>
        <div className="min-w-0 flex-1 pt-0.5">
          <p className="flex flex-wrap items-center gap-1 leading-tight">
            <Link to={`/app/feed/p/${post.page.slug}`} className="text-[15px] font-semibold text-text-primary-light hover:underline dark:text-text-primary-dark">
              {post.page.name}
            </Link>
            {post.page.verified && <BadgeCheck size={14} className="text-blue-500" aria-label="Verified" />}
          </p>
          <p className="mt-0.5 flex items-center gap-1 text-[12px] text-text-secondary-light dark:text-text-secondary-dark">
            <Link to={`/app/feed/post/${post.id}`} title={fullTime(post.publishedAt ?? post.createdAt)} className="hover:underline">{relativeTime(post.publishedAt ?? post.createdAt)}</Link>
            <span aria-hidden>·</span>
            <span className="flex items-center gap-0.5" title={AUDIENCE_META[post.audience]?.label}>{AUDIENCE_META[post.audience]?.icon}</span>
            {post.editedAt && <><span aria-hidden>·</span><span>Edited</span></>}
          </p>
        </div>
        <div ref={menuRef} className="relative -mr-1">
          <button onClick={() => setMenu((v) => !v)} aria-label="Post actions" aria-haspopup="menu" aria-expanded={menu} className="feed-act grid h-9 w-9 place-items-center rounded-full text-text-secondary-light focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:text-text-secondary-dark">
            <MoreHorizontal size={20} />
          </button>
          {menu && (
            <div role="menu" className="animate-pop absolute right-0 top-full z-30 mt-1 w-52 rounded-xl bg-white p-1 shadow-[0_12px_28px_rgba(0,0,0,0.2)] ring-1 ring-black/5 dark:bg-elevated-dark dark:ring-white/10">
              <MenuItem icon={<Bookmark size={16} className={post.bookmarked ? 'fill-current text-blue-600' : ''} />} label={post.bookmarked ? 'Remove from saved' : 'Save post'} onClick={() => { void toggleBookmark(post.id); setMenu(false); }} />
              <MenuItem icon={<Link2 size={16} />} label="Copy link" onClick={() => {
                setMenu(false);
                navigator.clipboard.writeText(`${location.origin}/app/feed/post/${post.id}`)
                  .then(() => toastConfirm('Link copied'))
                  .catch(() => notify({ title: 'Could not copy the link', tone: 'error' }));
              }} />
              {post.canPin && <MenuItem icon={<Pin size={16} className={post.pinned ? 'fill-current text-blue-600' : ''} />} label={post.pinned ? 'Unpin from page' : 'Pin to page'} onClick={() => {
                setMenu(false);
                api.setPostPinned(post.id, !post.pinned)
                  .then((updated) => { patch(post.id, updated); toastConfirm(updated.pinned ? 'Pinned to the top of the page' : 'Unpinned'); })
                  .catch((e: unknown) => notify({ title: e instanceof Error ? e.message : 'Could not pin this post', tone: 'error' }));
              }} />}
              {post.canEdit && <MenuItem icon={<Pencil size={16} />} label="Edit post" onClick={() => { setMenu(false); window.dispatchEvent(new CustomEvent('feed:edit', { detail: post.id })); }} />}
              {post.canEdit && <MenuItem icon={<EyeOff size={16} />} label="Move to drafts" onClick={() => {
                setMenu(false);
                api.unpublishPost(post.id).catch(() => notify({ title: 'Could not move this post to drafts', tone: 'error' }));
              }} />}
              {(post.canEdit || post.canModerate) && <MenuItem danger icon={<Trash2 size={16} />} label="Delete post" onClick={() => {
                setMenu(false);
                if (!window.confirm('Delete this post?')) return;
                api.deletePost(post.id).catch(() => notify({ title: 'Could not delete this post', tone: 'error' }));
              }} />}
              {post.author.id !== currentUserId && <MenuItem icon={<Flag size={16} />} label="Report post" onClick={() => { setMenu(false); window.dispatchEvent(new CustomEvent('feed:report', { detail: { type: 'post', id: post.id } })); }} />}
            </div>
          )}
        </div>
      </header>

      {post.body && (
        <div className="px-3 pt-2 text-[15px] leading-[1.34] text-text-primary-light sm:px-4 dark:text-text-primary-dark">
          <p className="whitespace-pre-wrap break-words">{renderRichText(bodyText)}</p>
          {clamp && (
            <button onClick={() => setExpanded(true)} className="font-semibold text-text-secondary-light hover:underline dark:text-text-secondary-dark">See more</button>
          )}
        </div>
      )}

      {/* Media bleeds to the card edges, Facebook-style. */}
      {post.media.length > 0 && (
        <div className="mt-2">
          <MediaGallery media={post.media} bleed />
        </div>
      )}

      <div className="px-3 sm:px-4">
        {post.poll && <PollBlock postId={post.id} poll={post.poll} />}
        {post.event && <EventBlock postId={post.id} event={post.event} />}
        {post.linkPreview && <LinkPreview preview={post.linkPreview} />}
      </div>

      {/* Engagement summary */}
      {(post.reactions.total > 0 || post.commentCount > 0 || post.shareCount > 0) && (
        <div className="mt-2.5 flex items-center justify-between px-3 pb-0.5 text-[13px] text-text-secondary-light sm:px-4 dark:text-text-secondary-dark">
          <div className="flex items-center">
            {post.reactions.top.length > 0 && <ReactionBubbles reactions={post.reactions.top} />}
            {post.reactions.total > 0 && (
              <span className="feed-count-tick hover:underline" key={post.reactions.total}>{reactionLabel(post)}</span>
            )}
          </div>
          <div className="flex gap-3">
            {post.commentCount > 0 && <button onClick={() => setShowComments(true)} className="hover:underline">{post.commentCount} {post.commentCount === 1 ? 'comment' : 'comments'}</button>}
            {post.shareCount > 0 && <span>{post.shareCount} {post.shareCount === 1 ? 'share' : 'shares'}</span>}
          </div>
        </div>
      )}

      {/* Action bar — 3 equal buttons, exactly like Facebook. */}
      <div className="mx-3 mt-1 flex items-stretch border-t border-black/[0.08] py-1 sm:mx-4 dark:border-white/[0.06]">
        <div className="relative flex-1" {...press}>
          {pickerOpen && <ReactionPicker onPick={doReact} onClose={() => setPickerOpen(false)} />}
          <button
            onClick={() => doReact(primaryReaction)}
            aria-pressed={post.reactions.mine !== null}
            aria-label={post.reactions.mine ? `${FEED_REACTION_META[post.reactions.mine].label} — click to remove, hold for more reactions` : 'Like — hold for more reactions'}
            className={actionButton}
            style={mineTint ? { color: mineTint } : undefined}
          >
            {burst && <ReactionBurst reaction={burst.reaction} seed={burst.seed} />}
            <span key={thumbPop} className={`grid place-items-center ${thumbPop ? 'feed-thumb-pop' : ''}`}>
              <ReactionIcon reaction={primaryReaction} active={post.reactions.mine !== null} size={19} />
            </span>
            {post.reactions.mine ? FEED_REACTION_META[post.reactions.mine].label : 'Like'}
          </button>
        </div>
        <button
          onClick={() => setShowComments((v) => !v)}
          disabled={post.commentPolicy === 'closed' && !post.canComment}
          aria-expanded={showComments}
          className={`${actionButton} disabled:opacity-40`}
        >
          <MessageCircle size={18} /> Comment
        </button>
        <button onClick={() => void share()} className={actionButton}>
          <Share2 size={17} /> Share
        </button>
      </div>

      {(showComments || permalink) && <Comments post={post} autoFocus={showComments && !permalink} />}
    </article>
  );
};

/* The three action-bar buttons share one look; the Like button adds its tint inline. */
const actionButton =
  'feed-act relative flex flex-1 items-center justify-center gap-2 rounded-md py-1.5 text-[15px] font-semibold text-[#65676b] transition-colors ' +
  'focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500 dark:text-text-secondary-dark';

function reactionLabel(post: FeedPostView): string {
  const total = post.reactions.total;
  if (post.reactions.mine && total === 1) return 'You';
  if (post.reactions.mine) return `You and ${total - 1} ${total - 1 === 1 ? 'other' : 'others'}`;
  return String(total);
}

const MenuItem: React.FC<{ icon: React.ReactNode; label: string; onClick: () => void; danger?: boolean }> = ({ icon, label, onClick, danger }) => (
  <button
    onClick={onClick}
    className={`flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left text-[15px] font-medium transition-colors ${
      danger ? 'text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20' : 'text-text-primary-light hover:bg-black/[0.05] dark:text-text-primary-dark dark:hover:bg-white/5'
    }`}
  >
    {icon} {label}
  </button>
);

const LinkPreview: React.FC<{ preview: NonNullable<FeedPostView['linkPreview']> }> = ({ preview }) => {
  // An OpenGraph thumbnail is someone else's server, not ours — it 404s or
  // times out far more often than our own media. Facebook's own link cards
  // just drop the image rather than show a broken one, so we do too.
  const [imageFailed, setImageFailed] = useState(false);
  return (
    <a href={preview.url} target="_blank" rel="noopener noreferrer nofollow"
      className="mt-3 flex overflow-hidden rounded-lg border border-border-light transition-colors hover:bg-surface-light dark:border-border-dark/50 dark:hover:bg-card-dark/40">
      {preview.image && !imageFailed && (
        <img src={preview.image} alt="" className="h-24 w-24 shrink-0 object-cover sm:h-28 sm:w-40" loading="lazy" decoding="async" onError={() => setImageFailed(true)} />
      )}
      <div className="min-w-0 flex-1 p-3">
        <p className="text-[11px] uppercase tracking-wide text-text-secondary-light dark:text-text-secondary-dark">{preview.siteName ?? new URL(preview.url).hostname}</p>
        <p className="truncate text-sm font-semibold text-text-primary-light dark:text-text-primary-dark">{preview.title ?? preview.url}</p>
        {preview.description && <p className="mt-0.5 line-clamp-2 text-xs text-text-secondary-light dark:text-text-secondary-dark">{preview.description}</p>}
      </div>
    </a>
  );
};
