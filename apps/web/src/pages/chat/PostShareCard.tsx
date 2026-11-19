import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Newspaper, Lock } from 'lucide-react';
import type { FeedPostView } from '@tupo/shared';
import { getPost } from '../feed/api';
import { useMediaUrl } from '../feed/lib';

/**
 * A feed post shared into a conversation (F-07, `post_share` messages).
 *
 * The post is fetched with the reader's own rights: someone who may not see
 * it (a staff-only post shared to a student, a deleted post) gets "not
 * available" and nothing of its content — the message itself only carries
 * the post's id and a plain link. Results are kept per page load so a log
 * with the same post shared twice asks once.
 */
const cache = new Map<string, Promise<FeedPostView | null>>();
const load = (id: string) => {
  let p = cache.get(id);
  if (!p) { p = getPost(id).then((x) => x ?? null).catch(() => null); cache.set(id, p); }
  return p;
};

export const PostShareCard: React.FC<{ postId: string; onDark: boolean }> = ({ postId, onDark }) => {
  const [post, setPost] = useState<FeedPostView | null | undefined>(undefined);
  useEffect(() => {
    let alive = true;
    void load(postId).then((p) => { if (alive) setPost(p); });
    return () => { alive = false; };
  }, [postId]);
  const firstImage = post?.media.find((m) => m.kind === 'image');
  const thumb = useMediaUrl(firstImage?.fileId, Boolean(firstImage), 0, undefined, true);
  const avatar = useMediaUrl(post?.page.avatarFileId, Boolean(post?.page.avatarFileId), 0, undefined, true);

  const box = `mt-1 block w-72 max-w-full overflow-hidden rounded-xl border text-left ${
    onDark ? 'border-white/25 bg-white/10 text-white hover:bg-white/15' : 'border-border-light bg-white text-text-primary-light hover:bg-surface-light dark:border-border-dark/50 dark:bg-elevated-dark dark:text-text-primary-dark'
  }`;

  if (post === undefined) {
    return (
      <div className={box} aria-busy="true" aria-label="Loading the shared post">
        <div className="space-y-2 p-3"><div className="feed-skeleton h-3 w-1/2 rounded" /><div className="feed-skeleton h-3 w-4/5 rounded" /></div>
      </div>
    );
  }
  if (post === null) {
    return (
      <div className={`${box} flex items-center gap-2 p-3 text-xs opacity-80`} data-testid="post-share-unavailable">
        <Lock size={14} /> This post isn't available to you.
      </div>
    );
  }
  return (
    <Link to={`/app/feed/post/${post.id}`} className={box} data-testid="post-share-card">
      {thumb && <img src={thumb} alt="" className="h-36 w-full object-cover" />}
      <div className="p-3">
        <p className={`mb-1 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide ${onDark ? 'text-white/80' : 'text-blue-700 dark:text-blue-300'}`}>
          {avatar ? <img src={avatar} alt="" className="h-4 w-4 rounded-full object-cover" /> : <Newspaper size={12} />}
          {post.page.name}
        </p>
        <p className="line-clamp-3 text-sm">{post.body || (post.media.length ? 'Photo or video' : 'Post')}</p>
        <p className={`mt-1.5 text-[11px] font-medium ${onDark ? 'text-white/75' : 'text-text-secondary-light dark:text-text-secondary-dark'}`}>View post on Tupo Feed</p>
      </div>
    </Link>
  );
};
