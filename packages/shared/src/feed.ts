/**
 * Tupo Feed — the shared contract (SRS §6.7, FR-FEED-1…12).
 *
 * Imported by `@tupo/feed` (the domain), `apps/api` (REST), `apps/realtime`
 * (live updates) and `apps/web` (every screen), so a post shape or an event
 * payload cannot drift between the four.
 */

/* ────────────────────────────────────────────────────────────────────────── *
 * Enumerations & limits
 * ────────────────────────────────────────────────────────────────────────── */

export const FEED_PAGE_KINDS = ['official', 'club', 'class', 'community'] as const;
export type FeedPageKind = (typeof FEED_PAGE_KINDS)[number];

/** Coarse, role-based. space_members is not populated in this deployment, so
 *  the authoritative check is the viewer's RBAC role level. */
export const FEED_AUDIENCES = ['everyone', 'staff', 'students', 'parents'] as const;
export type FeedAudience = (typeof FEED_AUDIENCES)[number];

export const FEED_POST_TYPES = ['standard', 'announcement', 'poll', 'event'] as const;
export type FeedPostType = (typeof FEED_POST_TYPES)[number];

export const FEED_POST_STATUSES = ['draft', 'scheduled', 'published', 'unpublished'] as const;
export type FeedPostStatus = (typeof FEED_POST_STATUSES)[number];

export const FEED_COMMENT_POLICIES = ['open', 'followers', 'closed'] as const;
export type FeedCommentPolicy = (typeof FEED_COMMENT_POLICIES)[number];

/** The six reactions, in picker order. `like` is the default tap. */
export const FEED_REACTIONS = ['like', 'love', 'celebrate', 'support', 'insightful', 'curious'] as const;
export type FeedReaction = (typeof FEED_REACTIONS)[number];

export const FEED_REACTION_META: Record<FeedReaction, { emoji: string; label: string; tint: string }> = {
  like:       { emoji: '👍', label: 'Like',       tint: '#2563eb' },
  love:       { emoji: '❤️', label: 'Love',       tint: '#e11d48' },
  celebrate:  { emoji: '🎉', label: 'Celebrate',  tint: '#7c3aed' },
  support:    { emoji: '🤝', label: 'Support',    tint: '#0d9488' },
  insightful: { emoji: '💡', label: 'Insightful', tint: '#d97706' },
  curious:    { emoji: '🤔', label: 'Curious',    tint: '#4b5563' },
};

export const FEED_REPORT_REASONS = [
  'spam', 'harassment', 'hate', 'violence', 'nudity', 'misinformation', 'self_harm', 'other',
] as const;
export type FeedReportReason = (typeof FEED_REPORT_REASONS)[number];

export const FEED_LIMITS = {
  /** Followers at or below this get fan-out-on-write; above, read-time merge. */
  FANOUT_THRESHOLD: 500,
  PAGE_SIZE: 20,
  MAX_PAGE_SIZE: 50,
  MAX_MEDIA: 10,
  MAX_POLL_OPTIONS: 6,
  MIN_POLL_OPTIONS: 2,
  POST_BODY_MAX: 20_000,
  COMMENT_BODY_MAX: 8_000,
  PAGE_BIO_MAX: 500,
  /** Quick-action links under a page's title. */
  PAGE_LINKS_MAX: 5,
  PAGE_LINK_LABEL_MAX: 40,
  PAGE_LINK_URL_MAX: 500,
  /** What a page calls an editor — "President", "Patron". Display only. */
  EDITOR_TITLE_MAX: 40,
  /** Pins are a spotlight, not a second feed. */
  MAX_PINNED_PER_PAGE: 3,
  REEL_CAPTION_MAX: 2_200,
  REEL_COMMENT_BODY_MAX: 2_000,
  REEL_PAGE_SIZE: 10,
  /** A vertical clip, not a lecture recording. */
  REEL_MAX_DURATION_SECONDS: 90,
  STORY_CAPTION_MAX: 500,
  /** How long a status stays up — the whole point of a "story" (FR-FEED-14). */
  STORY_TTL_HOURS: 24,
  /** Facebook caps this too — beyond it a story bar stops being scannable. */
  MAX_ACTIVE_STORIES_PER_AUTHOR: 20,
} as const;

export type FeedSort = 'recent' | 'top';
export type FeedFilter = 'all' | 'following' | 'announcements' | 'bookmarks';

/* ────────────────────────────────────────────────────────────────────────── *
 * Value objects
 * ────────────────────────────────────────────────────────────────────────── */

export interface FeedMediaItem {
  fileId: string;
  kind: 'image' | 'video' | 'document';
  name?: string;
  mime?: string;
  size?: number;
  w?: number | null;
  h?: number | null;
  /** Short-lived signed URL, filled by the API on read. */
  url?: string | null;
  posterUrl?: string | null;
}

export interface FeedLinkPreview {
  url: string;
  title?: string | null;
  description?: string | null;
  image?: string | null;
  siteName?: string | null;
}

export interface FeedPollOption { text: string; votes: number; }

export interface FeedPollView {
  question: string;
  options: FeedPollOption[];
  multi: boolean;
  closesAt: string | null;
  closed: boolean;
  totalVoters: number;
  /** The viewer's chosen option indexes; empty if they have not voted. */
  myVotes: number[];
}

export interface FeedEventView {
  title: string;
  startsAt: string;
  endsAt: string | null;
  location: string | null;
  meetingId: string | null;
  /** Whether the viewer marked "going". */
  going: boolean;
  goingCount: number;
}

export interface FeedPerson {
  id: string;
  name: string;
  avatarUrl: string | null;
  roleName?: string | null;
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Pages
 * ────────────────────────────────────────────────────────────────────────── */

/** A quick-action button under the page title. `url` is http(s) or mailto. */
export interface FeedPageLink {
  label: string;
  url: string;
}

export interface FeedPageSummary {
  id: string;
  slug: string;
  name: string;
  bio: string;
  links: FeedPageLink[];
  kind: FeedPageKind;
  audience: FeedAudience;
  mandatory: boolean;
  verified: boolean;
  /** File ids — the web resolves them to short-lived media URLs, same as chat. */
  avatarFileId: string | null;
  coverFileId: string | null;
  accent: string;
  followerCount: number;
  postCount: number;
  /** Viewer-relative. */
  following: boolean;
  notify: boolean;
  myRole: 'owner' | 'editor' | null;
  canPost: boolean;
}

export type FeedPageEditorRole = 'owner' | 'editor';

export interface FeedPageEditor extends FeedPerson {
  role: FeedPageEditorRole;
  /** Display title on the page's team list; empty when none was given. */
  title: string;
}

/** One follower of a page, as only that page's owners may see them. */
export interface FeedPageFollower extends FeedPerson {
  followedAt: string;
}

export interface FeedPageDetail extends FeedPageSummary {
  createdAt: string;
  editors: FeedPageEditor[];
}

export interface CreatePagePayload {
  name: string;
  slug?: string;
  bio?: string;
  kind?: FeedPageKind;
  audience?: FeedAudience;
  accent?: string;
  avatarFileId?: string | null;
  coverFileId?: string | null;
  links?: FeedPageLink[];
}

export interface UpdatePageEditorPayload {
  role?: FeedPageEditorRole;
  title?: string;
}

export type UpdatePagePayload = Partial<CreatePagePayload> & {
  verified?: boolean;
  mandatory?: boolean;
};

/* ────────────────────────────────────────────────────────────────────────── *
 * Posts
 * ────────────────────────────────────────────────────────────────────────── */

export interface FeedReactionSummary {
  total: number;
  byEmoji: Partial<Record<FeedReaction, number>>;
  /** Up to 3, most common first — for the reaction bar label. */
  top: FeedReaction[];
  /** The viewer's reaction, or null. */
  mine: FeedReaction | null;
  /** A few names for the facepile / "You and 4 others". */
  sample: FeedPerson[];
}

export interface FeedPostView {
  id: string;
  page: FeedPageSummary;
  author: FeedPerson;
  body: string;
  format: 'plain' | 'rich';
  media: FeedMediaItem[];
  linkPreview: FeedLinkPreview | null;
  type: FeedPostType;
  poll: FeedPollView | null;
  event: FeedEventView | null;
  audience: FeedAudience;
  status: FeedPostStatus;
  scheduledAt: string | null;
  publishedAt: string | null;
  pinned: boolean;
  commentPolicy: FeedCommentPolicy;
  editedAt: string | null;
  reactions: FeedReactionSummary;
  commentCount: number;
  shareCount: number;
  viewCount: number;
  uniqueReach: number;
  bookmarked: boolean;
  /** Viewer-relative capability flags, so the client never guesses. */
  canComment: boolean;
  canEdit: boolean;
  canModerate: boolean;
  /** Pinning is a claim on the page, so it needs a current say in it. */
  canPin: boolean;
  createdAt: string;
}

export interface FeedPage_<T> { items: T[]; nextCursor: string | null; }
export type FeedTimelinePage = FeedPage_<FeedPostView>;
export type FeedReelsPage = FeedPage_<FeedReelView>;

export interface ComposePostPayload {
  pageId: string;
  body?: string;
  format?: 'plain' | 'rich';
  media?: FeedMediaItem[];
  linkPreview?: FeedLinkPreview | null;
  type?: FeedPostType;
  poll?: { question: string; options: string[]; multi?: boolean; closesAt?: string | null } | null;
  event?: { title: string; startsAt: string; endsAt?: string | null; location?: string | null; meetingId?: string | null } | null;
  audience?: FeedAudience;
  commentPolicy?: FeedCommentPolicy;
  pinned?: boolean;
  /** draft | scheduled | published. `scheduled` requires `scheduledAt`. */
  status?: Extract<FeedPostStatus, 'draft' | 'scheduled' | 'published'>;
  scheduledAt?: string | null;
}

export type EditPostPayload = Partial<
  Pick<ComposePostPayload, 'body' | 'format' | 'media' | 'linkPreview' | 'audience' | 'commentPolicy' | 'pinned'>
>;

/* ────────────────────────────────────────────────────────────────────────── *
 * Comments
 * ────────────────────────────────────────────────────────────────────────── */

export interface FeedCommentView {
  id: string;
  postId: string;
  parentId: string | null;
  author: FeedPerson;
  body: string;
  media: FeedMediaItem[];
  reactionCount: number;
  myReaction: FeedReaction | null;
  replyCount: number;
  editedAt: string | null;
  createdAt: string;
  canEdit: boolean;
  canModerate: boolean;
  /** Populated for top-level comments on first page load (up to 2). */
  replies?: FeedCommentView[];
}

export interface AddCommentPayload {
  body: string;
  parentId?: string | null;
  media?: FeedMediaItem[];
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Reels — short vertical videos, published by a person (not a page)
 * ────────────────────────────────────────────────────────────────────────── */

export interface FeedReelView {
  id: string;
  author: FeedPerson;
  caption: string;
  media: FeedMediaItem;
  audience: FeedAudience;
  likeCount: number;
  commentCount: number;
  viewCount: number;
  uniqueReach: number;
  /** Whether the viewer has liked this reel. */
  liked: boolean;
  canDelete: boolean;
  createdAt: string;
}

export interface ComposeReelPayload {
  caption?: string;
  media: FeedMediaItem;
  audience?: FeedAudience;
}

export interface FeedReelCommentView {
  id: string;
  reelId: string;
  author: FeedPerson;
  body: string;
  createdAt: string;
  canDelete: boolean;
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Stories — ephemeral 24-hour statuses, grouped by author
 * ────────────────────────────────────────────────────────────────────────── */

export interface FeedStoryView {
  id: string;
  author: FeedPerson;
  media: FeedMediaItem | null;
  caption: string;
  background: string;
  audience: FeedAudience;
  viewCount: number;
  /** Whether the viewer has already seen this one. */
  viewed: boolean;
  canDelete: boolean;
  createdAt: string;
  expiresAt: string;
}

/** One horizontal-bar entry: an author's still-active stories, newest last
 *  so the viewer plays oldest → newest, Instagram-style. */
export interface FeedStoryGroup {
  author: FeedPerson;
  stories: FeedStoryView[];
  /** True once every story in the group has been viewed. */
  allViewed: boolean;
  latestAt: string;
}

export interface ComposeStoryPayload {
  caption?: string;
  media?: FeedMediaItem | null;
  background?: string;
  audience?: FeedAudience;
}

export interface FeedStoryViewer extends FeedPerson {
  viewedAt: string;
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Moderation & analytics
 * ────────────────────────────────────────────────────────────────────────── */

export interface FeedReportView {
  id: string;
  targetType: 'post' | 'comment';
  targetId: string;
  postId: string | null;
  reason: FeedReportReason;
  note: string;
  status: 'open' | 'actioned' | 'dismissed';
  reporter: FeedPerson;
  createdAt: string;
  /** A rendered preview of the reported content. */
  preview: {
    kind: 'post' | 'comment';
    author: FeedPerson;
    pageName?: string;
    body: string;
    media: FeedMediaItem[];
    createdAt: string;
    removed: boolean;
  } | null;
}

export type FeedModerationAction = 'remove' | 'warn' | 'dismiss';

export interface FeedPageAnalytics {
  range: '7d' | '30d' | 'all';
  totals: {
    posts: number;
    impressions: number;
    uniqueReach: number;
    reactions: number;
    comments: number;
    shares: number;
    followerCount: number;
    followerGrowth: number;
  };
  /** One point per day, oldest first. */
  series: Array<{ date: string; impressions: number; reactions: number; comments: number }>;
  topPosts: Array<{ id: string; body: string; publishedAt: string; impressions: number; reactions: number; comments: number }>;
}

/* ────────────────────────────────────────────────────────────────────────── *
 * Rooms
 * ────────────────────────────────────────────────────────────────────────── */

export const feedPostRoom = (postId: string) => `feedpost:${postId}`;

/** Live like/comment/view counters for one reel's detail view. */
export const feedReelRoom = (reelId: string) => `feedreel:${reelId}`;

/**
 * Broadcast room for every published post in a given audience band. A client
 * joins the ones its role can see (`feedAudiencesForRole`) so a brand-new post
 * from *anyone* the viewer follows or not lands live, not just posts from
 * pages they already follow — the home feed shows everyone (FR-FEED-7).
 */
export const feedAudienceRoom = (audience: FeedAudience) => `feedaudience:${audience}`;

/** Which audience bands a session role may see — mirrors `visibleAudiences`
 *  in `@tupo/feed`, kept here too since the socket gateway has no DB access
 *  and only knows the session's lowercase `role`, not the feed's RoleLevel. */
export function feedAudiencesForRole(role: string | undefined): FeedAudience[] {
  switch (role) {
    case 'admin':
    case 'staff':
      return ['everyone', 'staff', 'students', 'parents'];
    case 'student':
      return ['everyone', 'students'];
    case 'parent':
      return ['everyone', 'parents'];
    default:
      return ['everyone'];
  }
}
