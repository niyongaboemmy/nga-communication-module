-- Feed — Posts & Comments (FR-FEED-1…12).
--
-- A Facebook-page-style social + academic feed. The posting identity is a
-- *page* (feed_pages), never a person directly — a person posts "as" a page
-- they own or edit. Users follow pages; some pages are mandatory-follow for
-- their audience. Posts carry rich text, media galleries, links, polls and
-- events, have a lifecycle (draft → scheduled → published → unpublished), one
-- level of comment nesting, and reactions on both posts and comments.
--
-- Delivery is hybrid fan-out (FR-FEED-7): a post from an ordinary page is
-- pushed into every follower's feed_timeline at publish time; a post from a
-- page above FEED_FANOUT_THRESHOLD followers, or any mandatory page, is left
-- out and merged in at read time. See packages/feed/src/feed.ts.
--
-- Idempotent throughout. All ids are TEXT snowflakes; every FK to a person is
-- users(id). Audience is coarse and role-based ('everyone' | 'staff' |
-- 'students' | 'parents'), matching the fact that space_members is not
-- populated in this deployment — the authoritative audience check is the
-- user's RBAC role level.

/* ──────────────────────────────────────────────────────────────────────────
 * Pages — the posting identities (FR-FEED-1)
 * ────────────────────────────────────────────────────────────────────────── */

CREATE TABLE IF NOT EXISTS feed_pages (
  id             TEXT PRIMARY KEY,
  slug           TEXT        NOT NULL,
  name           TEXT        NOT NULL,
  bio            TEXT        NOT NULL DEFAULT '',
  kind           TEXT        NOT NULL DEFAULT 'community',  -- official | club | class | community
  audience       TEXT        NOT NULL DEFAULT 'everyone',   -- everyone | staff | students | parents
  -- A mandatory page auto-follows everyone in its audience and cannot be
  -- unfollowed. Its posts are merged at read time regardless of follower count.
  mandatory      BOOLEAN     NOT NULL DEFAULT false,
  verified       BOOLEAN     NOT NULL DEFAULT false,
  avatar_file_id TEXT        REFERENCES files(id) ON DELETE SET NULL,
  cover_file_id  TEXT        REFERENCES files(id) ON DELETE SET NULL,
  accent         TEXT        NOT NULL DEFAULT '#2563eb',
  follower_count INTEGER     NOT NULL DEFAULT 0,
  post_count     INTEGER     NOT NULL DEFAULT 0,
  created_by     TEXT        REFERENCES users(id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at     TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS feed_pages_slug_idx ON feed_pages (lower(slug)) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS feed_pages_kind_idx ON feed_pages (kind) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS feed_page_editors (
  page_id   TEXT        NOT NULL REFERENCES feed_pages(id) ON DELETE CASCADE,
  user_id   TEXT        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role      TEXT        NOT NULL DEFAULT 'editor',   -- owner | editor
  added_by  TEXT        REFERENCES users(id) ON DELETE SET NULL,
  added_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (page_id, user_id)
);
CREATE INDEX IF NOT EXISTS feed_page_editors_user_idx ON feed_page_editors (user_id);

CREATE TABLE IF NOT EXISTS feed_page_followers (
  page_id     TEXT        NOT NULL REFERENCES feed_pages(id) ON DELETE CASCADE,
  user_id     TEXT        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  notify      BOOLEAN     NOT NULL DEFAULT true,
  -- 'mandatory' follows are created by the system and block manual unfollow.
  source      TEXT        NOT NULL DEFAULT 'manual',   -- manual | mandatory
  followed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (page_id, user_id)
);
CREATE INDEX IF NOT EXISTS feed_page_followers_user_idx ON feed_page_followers (user_id);

/* ──────────────────────────────────────────────────────────────────────────
 * Posts (FR-FEED-2, 3, 4)
 * ────────────────────────────────────────────────────────────────────────── */

CREATE TABLE IF NOT EXISTS feed_posts (
  id             TEXT PRIMARY KEY,
  page_id        TEXT        NOT NULL REFERENCES feed_pages(id) ON DELETE CASCADE,
  author_id      TEXT        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body           TEXT        NOT NULL DEFAULT '',
  format         TEXT        NOT NULL DEFAULT 'plain',   -- plain | rich
  -- [{ fileId, kind: 'image'|'video'|'document', name, mime, size, w, h }]
  media          JSONB       NOT NULL DEFAULT '[]'::jsonb,
  link_preview   JSONB,                                  -- { url, title, description, image, siteName }
  type           TEXT        NOT NULL DEFAULT 'standard', -- standard | announcement | poll | event
  poll           JSONB,      -- { question, options: string[], multi, closesAt }
  event          JSONB,      -- { title, startsAt, endsAt, location, meetingId }
  audience       TEXT        NOT NULL DEFAULT 'everyone', -- everyone | staff | students | parents
  status         TEXT        NOT NULL DEFAULT 'published',-- draft | scheduled | published | unpublished
  scheduled_at   TIMESTAMPTZ,
  published_at   TIMESTAMPTZ,
  pinned         BOOLEAN     NOT NULL DEFAULT false,
  comment_policy TEXT        NOT NULL DEFAULT 'open',     -- open | followers | closed
  edited_at      TIMESTAMPTZ,
  edit_count     INTEGER     NOT NULL DEFAULT 0,
  reaction_count INTEGER     NOT NULL DEFAULT 0,
  comment_count  INTEGER     NOT NULL DEFAULT 0,
  view_count     INTEGER     NOT NULL DEFAULT 0,   -- total impressions
  unique_reach   INTEGER     NOT NULL DEFAULT 0,   -- distinct viewers
  share_count    INTEGER     NOT NULL DEFAULT 0,
  metadata       JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at     TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS feed_posts_page_idx
  ON feed_posts (page_id, published_at DESC) WHERE deleted_at IS NULL AND status = 'published';
CREATE INDEX IF NOT EXISTS feed_posts_published_idx
  ON feed_posts (published_at DESC, id DESC) WHERE deleted_at IS NULL AND status = 'published';
CREATE INDEX IF NOT EXISTS feed_posts_scheduled_idx
  ON feed_posts (scheduled_at) WHERE status = 'scheduled' AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS feed_posts_author_idx ON feed_posts (author_id, created_at DESC);

CREATE TABLE IF NOT EXISTS feed_post_edits (
  id         TEXT PRIMARY KEY,
  post_id    TEXT        NOT NULL REFERENCES feed_posts(id) ON DELETE CASCADE,
  body       TEXT        NOT NULL DEFAULT '',
  media      JSONB       NOT NULL DEFAULT '[]'::jsonb,
  edited_by  TEXT        REFERENCES users(id) ON DELETE SET NULL,
  edited_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS feed_post_edits_post_idx ON feed_post_edits (post_id, edited_at DESC);

/* ──────────────────────────────────────────────────────────────────────────
 * Reactions (FR-FEED-5) — one per user per post, switchable
 * ────────────────────────────────────────────────────────────────────────── */

CREATE TABLE IF NOT EXISTS feed_reactions (
  post_id    TEXT        NOT NULL REFERENCES feed_posts(id) ON DELETE CASCADE,
  user_id    TEXT        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  emoji      TEXT        NOT NULL DEFAULT 'like',  -- like|love|celebrate|support|insightful|curious
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (post_id, user_id)
);
CREATE INDEX IF NOT EXISTS feed_reactions_post_idx ON feed_reactions (post_id, emoji);

/* ──────────────────────────────────────────────────────────────────────────
 * Comments (FR-FEED-5, 9) — exactly one level of nesting
 * ────────────────────────────────────────────────────────────────────────── */

CREATE TABLE IF NOT EXISTS feed_comments (
  id             TEXT PRIMARY KEY,
  post_id        TEXT        NOT NULL REFERENCES feed_posts(id) ON DELETE CASCADE,
  -- NULL = top-level. A reply always points at a top-level comment; a reply to
  -- a reply is re-parented to that reply's parent in code.
  parent_id      TEXT        REFERENCES feed_comments(id) ON DELETE CASCADE,
  author_id      TEXT        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body           TEXT        NOT NULL DEFAULT '',
  media          JSONB       NOT NULL DEFAULT '[]'::jsonb,
  reaction_count INTEGER     NOT NULL DEFAULT 0,
  reply_count    INTEGER     NOT NULL DEFAULT 0,
  edited_at      TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at     TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS feed_comments_post_idx ON feed_comments (post_id, created_at) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS feed_comments_parent_idx ON feed_comments (parent_id, created_at) WHERE parent_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS feed_comment_reactions (
  comment_id TEXT        NOT NULL REFERENCES feed_comments(id) ON DELETE CASCADE,
  user_id    TEXT        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  emoji      TEXT        NOT NULL DEFAULT 'like',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (comment_id, user_id)
);

/* ──────────────────────────────────────────────────────────────────────────
 * Polls (FR-FEED-2) — one row per chosen option, so multi-select is natural
 * ────────────────────────────────────────────────────────────────────────── */

CREATE TABLE IF NOT EXISTS feed_poll_votes (
  post_id      TEXT        NOT NULL REFERENCES feed_posts(id) ON DELETE CASCADE,
  user_id      TEXT        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  option_index INTEGER     NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (post_id, user_id, option_index)
);
CREATE INDEX IF NOT EXISTS feed_poll_votes_post_idx ON feed_poll_votes (post_id, option_index);

/* ──────────────────────────────────────────────────────────────────────────
 * Timeline — precomputed fan-out-on-write rows (FR-FEED-7)
 * ────────────────────────────────────────────────────────────────────────── */

CREATE TABLE IF NOT EXISTS feed_timeline (
  user_id      TEXT        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  post_id      TEXT        NOT NULL REFERENCES feed_posts(id) ON DELETE CASCADE,
  page_id      TEXT        NOT NULL REFERENCES feed_pages(id) ON DELETE CASCADE,
  score        REAL        NOT NULL DEFAULT 0,
  published_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  reason       TEXT        NOT NULL DEFAULT 'follow',  -- follow | author
  PRIMARY KEY (user_id, post_id)
);
CREATE INDEX IF NOT EXISTS feed_timeline_recent_idx ON feed_timeline (user_id, published_at DESC, post_id DESC);
CREATE INDEX IF NOT EXISTS feed_timeline_top_idx    ON feed_timeline (user_id, score DESC, post_id DESC);

/* ──────────────────────────────────────────────────────────────────────────
 * Impressions & reach (FR-FEED-10)
 * ────────────────────────────────────────────────────────────────────────── */

CREATE TABLE IF NOT EXISTS feed_post_views (
  post_id  TEXT        NOT NULL REFERENCES feed_posts(id) ON DELETE CASCADE,
  user_id  TEXT        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  views    INTEGER     NOT NULL DEFAULT 1,
  first_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (post_id, user_id)
);

/* ──────────────────────────────────────────────────────────────────────────
 * Saved posts
 * ────────────────────────────────────────────────────────────────────────── */

CREATE TABLE IF NOT EXISTS feed_bookmarks (
  user_id    TEXT        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  post_id    TEXT        NOT NULL REFERENCES feed_posts(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, post_id)
);
CREATE INDEX IF NOT EXISTS feed_bookmarks_user_idx ON feed_bookmarks (user_id, created_at DESC);

/* ──────────────────────────────────────────────────────────────────────────
 * Moderation queue (FR-FEED-8)
 * ────────────────────────────────────────────────────────────────────────── */

CREATE TABLE IF NOT EXISTS feed_reports (
  id           TEXT PRIMARY KEY,
  target_type  TEXT        NOT NULL,           -- post | comment
  target_id    TEXT        NOT NULL,
  post_id      TEXT        REFERENCES feed_posts(id) ON DELETE CASCADE,
  reporter_id  TEXT        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reason       TEXT        NOT NULL DEFAULT 'other',
  note         TEXT        NOT NULL DEFAULT '',
  status       TEXT        NOT NULL DEFAULT 'open',  -- open | actioned | dismissed
  resolution   TEXT,                                 -- removed | warned | dismissed
  resolved_by  TEXT        REFERENCES users(id) ON DELETE SET NULL,
  resolved_at  TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS feed_reports_status_idx ON feed_reports (status, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS feed_reports_one_per_reporter_idx
  ON feed_reports (target_type, target_id, reporter_id) WHERE status = 'open';
