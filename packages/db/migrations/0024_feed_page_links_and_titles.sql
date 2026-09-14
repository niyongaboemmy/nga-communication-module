-- Feed pages: quick-action links and titled editors (FR-FEED-1).
--
-- A club page needs to point people somewhere — a registration form, a
-- contact address — without burying the URL in its bio. `links` is a short
-- ordered list of { label, url } rendered as buttons under the page title;
-- the domain caps its length and restricts the scheme to http(s)/mailto.
--
-- An editor's `title` is what the page calls them ("President", "Patron").
-- It is display-only: authority still comes from `role`.

ALTER TABLE feed_pages
  ADD COLUMN IF NOT EXISTS links JSONB NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE feed_page_editors
  ADD COLUMN IF NOT EXISTS title TEXT NOT NULL DEFAULT '';

-- A page's pinned posts are read on every profile load, ahead of the stream.
CREATE INDEX IF NOT EXISTS feed_posts_page_pinned_idx
  ON feed_posts (page_id, published_at DESC)
  WHERE pinned AND deleted_at IS NULL AND status = 'published';
