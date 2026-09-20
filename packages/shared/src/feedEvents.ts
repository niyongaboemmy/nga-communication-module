/**
 * The Feed socket catalogue (FR-FEED-12 — live comments and reaction counts).
 *
 * Feed rides the **default namespace** alongside chat and presence: it shares
 * the per-user room with the shell and its traffic is light (a viewer is
 * subscribed only to the handful of posts currently on screen). Meet is the
 * only feature that gets its own namespace.
 *
 * One room kind beyond the existing `user:<id>`:
 *   `feedpost:<postId>`  everyone with that post visible on screen
 *
 * Subscription is by the client naming the posts it can see; the payloads that
 * flow back (reaction summaries, comment bodies that are already world-visible
 * within the feed's audience) carry nothing a `FEED_VIEW` holder could not
 * fetch over REST, so there is no per-post ACL at subscribe time — the coarse
 * gate is having a session at all.
 */

import type {
  FeedCommentView, FeedPostView, FeedReactionSummary, FeedReelCommentView, FeedReelView, FeedStoryView,
} from './feed.js';

export interface FeedClientToServerEvents {
  /** `kind` picks `feedpost:<id>` (default) or `feedreel:<id>` — see feedPostRoom/feedReelRoom. */
  'feed:subscribe': (
    p: { postIds: string[]; kind?: 'post' | 'reel' },
    ack?: (r: { ok: boolean; subscribed: string[] }) => void,
  ) => void;
  'feed:unsubscribe': (p: { postIds: string[]; kind?: 'post' | 'reel' }) => void;
}

export interface FeedServerToClientEvents {
  /** A new post reached this user's timeline (delivered on `user:<id>`). */
  'feed:post_new': (p: { post: FeedPostView }) => void;
  /** Body edited, pinned, poll/event mutated, counters moved. */
  'feed:post_updated': (p: { postId: string; post: FeedPostView }) => void;
  'feed:post_deleted': (p: { postId: string; byModerator: boolean }) => void;

  'feed:reaction': (p: { postId: string; reactions: FeedReactionSummary }) => void;

  'feed:comment_new': (p: { postId: string; comment: FeedCommentView }) => void;
  'feed:comment_updated': (p: { postId: string; comment: FeedCommentView }) => void;
  'feed:comment_deleted': (
    p: { postId: string; commentId: string; parentId: string | null; byModerator: boolean },
  ) => void;
  'feed:comment_reaction': (
    p: { postId: string; commentId: string; reactionCount: number },
  ) => void;

  /** Poll tallies moved — everyone watching sees the bars change. */
  'feed:poll_updated': (p: { postId: string; poll: NonNullable<FeedPostView['poll']> }) => void;

  /** Cheap counter bumps (views, shares) without re-sending the whole post. */
  'feed:counter': (
    p: { postId: string; commentCount?: number; shareCount?: number; viewCount?: number; uniqueReach?: number },
  ) => void;

  /* ── Reels ──────────────────────────────────────────────────────────────── */
  /** A new reel reached this audience (delivered on `feedaudience:<band>`). */
  'feed:reel_new': (p: { reel: FeedReelView }) => void;
  'feed:reel_deleted': (p: { reelId: string }) => void;
  'feed:reel_comment_new': (p: { reelId: string; comment: FeedReelCommentView }) => void;
  'feed:reel_counter': (
    p: { reelId: string; likeCount?: number; commentCount?: number; viewCount?: number; uniqueReach?: number; liked?: boolean },
  ) => void;

  /* ── Stories ────────────────────────────────────────────────────────────── */
  /** A new story reached this audience (delivered on `feedaudience:<band>`). */
  'feed:story_new': (p: { story: FeedStoryView }) => void;
  'feed:story_deleted': (p: { storyId: string; authorId: string }) => void;
}
