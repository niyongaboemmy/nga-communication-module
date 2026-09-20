-- Reels & Stories — personal, Facebook/Instagram-style publishing on top of
-- the Feed (extends FR-FEED with Reels and 24-hour Stories).
--
-- Unlike feed_posts, these are authored by a *person* directly, not "as a
-- page": every signed-in user may publish a reel or a status (FEED_REEL_POST /
-- FEED_STORY_POST are baseline permissions, see packages/shared/src/
-- permissions.ts), independent of owning or editing an institutional page.
-- They deliberately do not reuse feed_posts / feed_reactions / feed_comments —
-- feed_posts.page_id is NOT NULL there and is load-bearing for the follow/
-- timeline fan-out and page-analytics machinery throughout packages/feed, so
-- bolting a nullable "personal" identity onto it would ripple through nearly
-- every query in that package. These are a smaller, self-contained slice.
--
-- Same conventions as 0017_feed.sql: TEXT snowflake ids, TIMESTAMPTZ
-- everywhere, soft delete via deleted_at, audience is the same coarse
-- everyone|staff|students|parents enum enforced in code, idempotent DDL.

/* ──────────────────────────────────────────────────────────────────────────
 * Reels — short vertical videos
 * ────────────────────────────────────────────────────────────────────────── */

CREATE TABLE IF NOT EXISTS feed_reels (
  id             TEXT        PRIMARY KEY,
  author_id      TEXT        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  caption        TEXT        NOT NULL DEFAULT '',
  -- Exactly one video: { fileId, mime, size, w, h, durationSeconds, posterFileId }
  media          JSONB       NOT NULL,
  audience       TEXT        NOT NULL DEFAULT 'everyone',  -- everyone | staff | students | parents
  like_count     INTEGER     NOT NULL DEFAULT 0,
  comment_count  INTEGER     NOT NULL DEFAULT 0,
  view_count     INTEGER     NOT NULL DEFAULT 0,
  unique_reach   INTEGER     NOT NULL DEFAULT 0,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at     TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS feed_reels_recent_idx
  ON feed_reels (created_at DESC, id DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS feed_reels_author_idx ON feed_reels (author_id, created_at DESC);

CREATE TABLE IF NOT EXISTS feed_reel_likes (
  reel_id    TEXT        NOT NULL REFERENCES feed_reels(id) ON DELETE CASCADE,
  user_id    TEXT        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (reel_id, user_id)
);

CREATE TABLE IF NOT EXISTS feed_reel_comments (
  id         TEXT        PRIMARY KEY,
  reel_id    TEXT        NOT NULL REFERENCES feed_reels(id) ON DELETE CASCADE,
  author_id  TEXT        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body       TEXT        NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS feed_reel_comments_reel_idx
  ON feed_reel_comments (reel_id, created_at) WHERE deleted_at IS NULL;

-- Same shape as feed_post_views (0017_feed.sql) — total views + distinct
-- reach from one row per (reel, viewer).
CREATE TABLE IF NOT EXISTS feed_reel_views (
  reel_id  TEXT        NOT NULL REFERENCES feed_reels(id) ON DELETE CASCADE,
  user_id  TEXT        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  views    INTEGER     NOT NULL DEFAULT 1,
  first_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (reel_id, user_id)
);

/* ──────────────────────────────────────────────────────────────────────────
 * Stories — ephemeral 24-hour statuses
 * ────────────────────────────────────────────────────────────────────────── */

CREATE TABLE IF NOT EXISTS feed_stories (
  id             TEXT        PRIMARY KEY,
  author_id      TEXT        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Media stories: [{ fileId, kind: 'image'|'video', mime, size, w, h }].
  -- Text-only statuses carry none — `caption` + `background` (a gradient key)
  -- is a Facebook-style coloured status card.
  media          JSONB       NOT NULL DEFAULT '[]'::jsonb,
  caption        TEXT        NOT NULL DEFAULT '',
  background     TEXT        NOT NULL DEFAULT '',
  audience       TEXT        NOT NULL DEFAULT 'everyone',
  view_count     INTEGER     NOT NULL DEFAULT 0,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at     TIMESTAMPTZ NOT NULL,
  deleted_at     TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS feed_stories_active_idx
  ON feed_stories (author_id, created_at DESC) WHERE deleted_at IS NULL;
-- Read by the worker's story:sweep job (mirrors feed_posts_scheduled_idx).
CREATE INDEX IF NOT EXISTS feed_stories_expiry_idx
  ON feed_stories (expires_at) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS feed_story_views (
  story_id   TEXT        NOT NULL REFERENCES feed_stories(id) ON DELETE CASCADE,
  user_id    TEXT        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  viewed_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (story_id, user_id)
);
CREATE INDEX IF NOT EXISTS feed_story_views_story_idx ON feed_story_views (story_id, viewed_at);
