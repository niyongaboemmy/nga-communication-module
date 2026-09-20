-- Seed the two Reels/Stories permission keys added in 0025, purely additively.
--
-- `npm run db:seed` (packages/db/src/rbac.ts) is deliberately NOT run on every
-- deploy: it REPLACES each system role's entire permission set with
-- DEFAULT_ROLE_PERMISSIONS from code, which would silently discard any
-- permission an administrator has since customised on the Roles &
-- Permissions screen in production. A migration runs on every deploy and
-- must never do that either — so this file only INSERTs the new permission
-- catalog rows and grants them to roles that already hold FEED_VIEW,
-- touching no existing role_permissions row and removing nothing.
--
-- FEED_VIEW is the stand-in for "every signed-in role the feed applies to":
-- it's what every system role gets today (Student, Parent, Staff, Moderator,
-- Admin) and, unlike hardcoding those five names, it also reaches any custom
-- role an administrator has since created and given feed access to.

INSERT INTO permissions (key, category, description) VALUES
  ('FEED_STORY_POST', 'Feed & Posts', 'Publish a 24-hour status to your own story.'),
  ('FEED_REEL_POST',  'Feed & Posts', 'Publish a reel (short video) under your own name.')
ON CONFLICT (key) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT DISTINCT rp.role_id, p.id
  FROM role_permissions rp
  JOIN permissions viewp ON viewp.id = rp.permission_id AND viewp.key = 'FEED_VIEW'
  JOIN permissions p ON p.key IN ('FEED_STORY_POST', 'FEED_REEL_POST')
ON CONFLICT (role_id, permission_id) DO NOTHING;
