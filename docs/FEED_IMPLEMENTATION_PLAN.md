# Tupo Feed — Phase 4 Implementation Plan

**Scope:** the "Tupo Feed" row of the [SRS](TUPO_SRS.md) — `FR-FEED-1…12`. A
Facebook-page-style social + academic feed: institutional **Pages** as posting
identities, rich **Posts** (text, multi-image galleries, video, documents,
links, polls, events), one-level **Comments**, **Reactions** on posts and
comments, **hybrid fan-out** timelines, a **moderation queue**, **page
analytics**, and **live updates** over the existing socket.

It builds on the Phase 0 skeleton, the Phase 0.5 RBAC catalog (the five
`FEED_*` permissions already exist and are already bound to the seeded roles),
and copies the architecture of Chat and Mail exactly so the modules stay one
system.

---

## 1. Architectural fit (no new patterns)

| Concern | Chat / Mail does it this way | Feed copies it |
|---|---|---|
| Domain logic | `@tupo/chat`, `@tupo/mail` packages, imported by api **and** worker | new `@tupo/feed` package |
| Persistence | raw SQL via `getPool()`, snowflake text ids, idempotent `NNNN_*.sql` migration | `0017_feed.sql`, raw SQL |
| REST | `apps/api/src/routes/*.ts`, `authMiddleware` + `authorizePermission()` | `routes/feed.ts` mounted at `/api/feed` |
| Realtime | API commits the row, publishes to Redis `tupo:chat` channel `{rooms,event,payload}`; the gateway relays verbatim | reuse the **same** generic relay; add `feed:*` events + a `feed:subscribe` handler joining `feedpost:<id>` rooms |
| Socket contract | `packages/shared/src/chatEvents.ts` merged into `events.ts` | `packages/shared/src/feed.ts` + `feedEvents.ts` |
| Scheduled work | worker sweeps (`sendDueScheduled`) | `publishDueScheduledPosts()` sweep |
| Web feature | `apps/web/src/pages/<feature>/` with `api.ts` + a Provider + screens | `apps/web/src/pages/feed/` |
| Notifications | `@tupo/notify` row + per-user socket room | reuse for `feed.*` kinds |

**No new dependencies.** Rich text uses the TipTap already in `apps/web`;
animations are Tailwind v4 keyframes (the repo already defines `animate-pop`,
`animate-fade-in`); charts are hand-rolled inline SVG.

---

## 2. Data model — `packages/db/migrations/0017_feed.sql`

All ids `TEXT` snowflakes; every person FK is `users(id)`. Idempotent
(`CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`).

| Table | Purpose / key columns |
|---|---|
| `feed_pages` | posting identity — `slug` (unique), `name`, `kind` (`official`\|`club`\|`class`\|`community`), `bio`, `avatar_file_id`, `cover_file_id`, `verified`, `audience` (`everyone`\|`staff`\|`students`\|`parents`), `mandatory` (auto-follow its audience), `follower_count`, `post_count`, `created_by`, timestamps, `deleted_at` |
| `feed_page_editors` | `(page_id, user_id)` PK, `role` (`owner`\|`editor`) |
| `feed_page_followers` | `(page_id, user_id)` PK, `notify` bool, `followed_at` |
| `feed_posts` | `page_id`, `author_id`, `body`, `format` (`plain`\|`rich`), `media` jsonb `[{fileId,kind,w,h,blurhash}]`, `link_preview` jsonb, `type` (`standard`\|`announcement`\|`poll`\|`event`), `poll` jsonb `{question,options[],multi,closesAt}`, `event` jsonb `{title,startsAt,endsAt,location,meetingId}`, `audience` (`everyone`\|`staff`\|`students`\|`parents`), `status` (`draft`\|`scheduled`\|`published`\|`unpublished`), `scheduled_at`, `published_at`, `pinned`, `comment_policy` (`open`\|`followers`\|`closed`), `edited_at`, `edit_count`, counters (`reaction_count`, `comment_count`, `view_count`, `unique_reach`, `share_count`), timestamps, `deleted_at` |
| `feed_post_edits` | edit history (FR-FEED-4) — `post_id`, `body`, `edited_by`, `edited_at` |
| `feed_reactions` | `(post_id, user_id)` PK, `emoji` (`like`\|`love`\|`celebrate`\|`support`\|`insightful`\|`curious`) — one per user, switchable |
| `feed_comments` | `post_id`, `parent_id` (one level only — enforced in code), `author_id`, `body`, `reaction_count`, `reply_count`, `edited_at`, timestamps, `deleted_at` |
| `feed_comment_reactions` | `(comment_id, user_id)` PK, `emoji` |
| `feed_poll_votes` | `(post_id, user_id)` PK (single-choice) / `(post_id, user_id, option_index)` when `multi` — modelled as one row per choice, `option_index` |
| `feed_timeline` | fan-out-on-write — `(user_id, post_id)` PK, `page_id`, `score` real, `published_at`, `reason` (`follow`\|`mandatory`\|`author`) |
| `feed_post_views` | `(post_id, user_id)` PK, `first_at`, `views` int — feeds `unique_reach` / impressions (FR-FEED-10) |
| `feed_bookmarks` | `(user_id, post_id)` PK, `created_at` — "Saved" |
| `feed_reports` | `id`, `target_type` (`post`\|`comment`), `target_id`, `reporter_id`, `reason`, `note`, `status` (`open`\|`actioned`\|`dismissed`), `resolution`, `resolved_by`, timestamps (FR-FEED-8) |

**Hybrid fan-out (FR-FEED-7).** On publish, if the page's `follower_count ≤
FEED_FANOUT_THRESHOLD` (500) we `INSERT … SELECT` a `feed_timeline` row per
follower. Above the threshold, or for `mandatory` pages, nothing is written and
`GET /feed` merges those pages' recent posts at read time. The read query is
`timeline rows ∪ (recent posts from big/mandatory pages in my audience)`,
de-duplicated, ordered by `published_at DESC` (recent) or `score DESC`
(top), keyset-paginated on `(published_at, id)`.

**Ranking score (`sort=top`).** `log10(reactions + 2·comments + 3·shares + 1) −
(age_hours / 12)` plus `+1000` when `pinned`/`announcement`. Cheap, recomputed
per request over the candidate window.

---

## 3. `@tupo/feed` package

```
packages/feed/src/
  errors.ts       FeedError(status,message)
  config.ts       thresholds, page sizes, reaction set, limits
  pages.ts        create/update/delete page, follow/unfollow, editors,
                  listPagesForUser, ensureMandatoryFollows(userId)
  posts.ts        createPost (draft|schedule|publish), editPost (+history),
                  unpublish, deletePost, getPost (ACL), fanOut(post)
  feed.ts         getFeed(userId,{cursor,sort,pageId,filter}) — hybrid merge
  comments.ts     addComment (nesting guard), listComments, editComment,
                  deleteComment
  reactions.ts    reactToPost / reactToComment (toggle+switch) → returns summary
  polls.ts        vote(postId,userId,choices) → tallies
  views.ts        recordView(postId,userId) → impression + unique reach
  bookmarks.ts    add / remove / list
  moderation.ts   report(), listQueue(), act() (remove|dismiss|warn)
  analytics.ts    pageAnalytics(pageId,range), postAnalytics(postId)
  index.ts        re-exports + publishDueScheduledPosts() worker sweep
```

Authorisation that must not diverge between transports lives here:
`assertCanPostAs(userId, pageId)` (editor/owner + `FEED_POST`),
`assertCanModerate`, `assertVisible(userId, post)` (audience vs `roleLevel`).

---

## 4. API — `apps/api/src/routes/feed.ts` (mounted `/api/feed`)

| Method & path | Permission | Notes |
|---|---|---|
| `GET /feed?cursor=&sort=recent\|top&filter=all\|following\|bookmarks` | `FEED_VIEW` | hybrid merge |
| `GET /feed/pages?mine=1` · `POST /feed/pages` | `FEED_VIEW` · `FEED_PAGE_MANAGE` | |
| `GET /feed/pages/:id` · `PATCH` · `DELETE` | `FEED_VIEW` · `FEED_PAGE_MANAGE` | |
| `POST /feed/pages/:id/follow` · `DELETE …/follow` | `FEED_VIEW` | mandatory pages refuse unfollow |
| `GET /feed/pages/:id/posts` · `POST /feed/pages/:id/posts` | `FEED_VIEW` · `FEED_POST` | create supports `status=draft\|scheduled\|published` |
| `PATCH /feed/posts/:id` · `DELETE` · `POST /feed/posts/:id/publish` · `POST …/unpublish` | `FEED_POST` (+author/editor) | edit writes history |
| `POST /feed/posts/:id/reactions` `{emoji}` · `DELETE` | `FEED_COMMENT` | |
| `GET /feed/posts/:id/comments` · `POST` `{body,parentId?}` | `FEED_VIEW` · `FEED_COMMENT` | |
| `PATCH /feed/comments/:id` · `DELETE` · `POST /feed/comments/:id/reactions` | `FEED_COMMENT` / author | |
| `POST /feed/posts/:id/vote` `{choices:number[]}` | `FEED_COMMENT` | |
| `POST /feed/posts/:id/view` | `FEED_VIEW` | fire-and-forget impression |
| `POST /feed/posts/:id/bookmark` · `DELETE` · `GET /feed/bookmarks` | `FEED_VIEW` | |
| `POST /feed/posts/:id/report` · `POST /feed/comments/:id/report` | `REPORT_SUBMIT` | |
| `GET /feed/moderation` · `POST /feed/moderation/:id/act` | `MODERATION_QUEUE_VIEW` · `MODERATION_ACT` | |
| `GET /feed/pages/:id/analytics?range=7d\|30d\|all` | `FEED_ANALYTICS_VIEW` | |

Every mutating handler: commit row → `emitToConversation`-style relay to
`feedpost:<id>` and/or `emitToUsers` for timeline inserts → best-effort
`notify()` (`feed.mention`, `feed.comment`, `feed.reply`, `feed.reaction`,
`feed.announcement`). Errors funnelled through a `wrap()` that maps `FeedError`
to its status, same as `routes/chat.ts`.

---

## 5. Realtime — `apps/realtime/src/feed/handlers.ts`

- New events in `packages/shared/src/feed.ts` / `feedEvents.ts`, merged into
  `events.ts` (`FeedClientToServerEvents`, `FeedServerToClientEvents`).
- Client → server: `feed:subscribe {postIds[]}` (join `feedpost:<id>`, capped
  at 200), `feed:unsubscribe`.
- Server → client: `feed:post_new`, `feed:post_updated`, `feed:post_deleted`,
  `feed:reaction` (summary), `feed:comment_new`, `feed:comment_updated`,
  `feed:comment_deleted`, `feed:poll_updated`, `feed:counter` (view/share).
- Registered from `io.on('connection')` next to `registerChatHandlers`. The
  API→gateway path needs **zero** gateway changes — the existing `tupo:chat`
  relay already emits arbitrary `{rooms,event,payload}`.

---

## 6. Web — `apps/web/src/pages/feed/`

Route already stubbed in `App.tsx` (`<Route path="feed" …/>`); swap
`<ComingSoon>` for `<FeedLayout>` and add sub-routes:
`/app/feed` (home), `/app/feed/p/:slug` (page profile),
`/app/feed/pages` (directory + create), `/app/feed/post/:id` (permalink),
`/app/feed/moderation`, `/app/feed/saved`, `/app/feed/pages/:id/insights`.

| Component | What it does / modern touches |
|---|---|
| `FeedProvider.tsx` | feed cache, page-follow state, one `feed:subscribe` for visible cards (IntersectionObserver), optimistic reactions/comments, live merge |
| `FeedLayout.tsx` | responsive 3-column → 1-column: left `PageRail` (following, filters, Saved, shortcuts), center column, right `Sidebar` (suggested pages, upcoming events, your-page insights teaser). Sticky columns, independent scroll |
| `HighlightsBar.tsx` | horizontal snap-scroll of pinned announcements / live events — the "stories" analogue, academic flavour |
| `Composer.tsx` | collapsed pill → expands to modal. Page picker (post-as), audience chip, rich text (TipTap) with @mention + #hashtag, image/video/doc upload w/ drag-drop + reorder gallery, **Poll** builder, **Event** builder, schedule popover, draft autosave |
| `PostCard.tsx` | page avatar + verified tick, relative time, "Edited" chip, overflow menu (save, copy link, report, edit/delete/unpublish, pin). Body with linkified #tags/@mentions + "See more" clamp. `MediaGallery` (1 / 2 / 3 / 4+ mosaic + lightbox w/ keyboard nav). `LinkPreviewCard`. `PollBlock` (animated bars, live). `EventBlock` (add-to-calendar, join Meet). |
| `ReactionBar.tsx` | LinkedIn/FB-style: press-and-hold / hover opens `ReactionPicker` — 6 emoji that scale-bounce in (staggered keyframes); flying-emoji burst on select; facepile of who reacted |
| `Comments.tsx` | lazy load, one-level replies, per-comment reactions, inline composer, live insert, "View N previous" |
| `PageProfile.tsx` | cover + avatar, follow/notify toggle, tabs (Posts / About / Events), editor controls |
| `PageDirectory.tsx` / `CreatePageDialog.tsx` | browse by kind, search, create (owners) |
| `ModerationQueue.tsx` | reported items, context preview, approve/remove/warn, audit note |
| `PageInsights.tsx` | impressions / unique reach / reactions / comments / follower growth — inline SVG sparklines + bar list of top posts |
| `feed.css` (scoped keyframes) | `reaction-pop`, `emoji-fly`, `card-in`, shimmer skeletons |

Accessibility & responsiveness: keyboard-navigable reaction picker and
lightbox, `prefers-reduced-motion` disables the flourishes, 44px touch
targets, bottom-sheet composer on mobile, skeleton loaders, empty states from
`components/ui`.

---

## 7. Seed & config

- `packages/db/src/seed.ts` — add three starter pages idempotently by slug:
  **NGA Official** (`official`, `verified`, `mandatory`, audience `everyone`),
  **Sports & Clubs** (`club`), **Academics & Exams** (`official`, audience
  `students`). Owner = first Admin user if one exists, else `created_by NULL`
  and claimable.
- `ensureMandatoryFollows(userId)` runs on first `GET /feed` and on SSO
  hydrate so every user auto-follows mandatory pages (FR-FEED-1).
- `packages/feed/src/config.ts`: `FEED_FANOUT_THRESHOLD=500`,
  `FEED_PAGE_SIZE=20`, `MAX_MEDIA=10`, `MAX_POLL_OPTIONS=6`,
  `POST_BODY_MAX=20000`, `COMMENT_MAX=8000`, `EDIT_WINDOW` none (history kept).

---

## 8. Verification

**Unit / integration (Vitest + supertest, `tupo_test` DB)** —
`apps/api/src/__tests__/feed.test.ts`:

1. `FEED_VIEW` gates the feed; a user without it gets 403.
2. Create page requires `FEED_PAGE_MANAGE`; posting requires `FEED_POST` **and**
   page-editor — a Staff who is not an editor gets 403.
3. Draft is invisible in the feed; publish makes it appear; unpublish removes it.
4. Scheduled post stays hidden until `publishDueScheduledPosts()` runs, then
   fans out.
5. Hybrid fan-out: small page writes `feed_timeline` rows; a page over the
   threshold writes none and is still merged at read time.
6. Audience scoping: a `students`-audience post never reaches a Parent feed.
7. One reaction per user; switching emoji updates in place; count is correct.
8. Comment nesting capped at one level (reply-to-reply attaches to the parent).
9. Poll: single vs multi, re-vote replaces, tallies exclude deleted users.
10. Report → moderation queue → remove hides the post and writes `audit_log`.
11. Edit writes a `feed_post_edits` row and sets `edited_at`.
12. Mandatory page cannot be unfollowed (409).
13. Bookmarks round-trip.
14. Impression counts unique reach once per user.

**Live script** — `scripts/verify-feed.mjs` (pattern of `verify-mail.mjs`,
needs `npm run dev`): create pages + users across roles, post/comment/react
over REST, assert a second socket receives `feed:post_new` / `feed:reaction` /
`feed:comment_new`, assert analytics numbers.

**UI smoke** — `scripts/verify-feed-ui.mjs` (Playwright, pattern of
`verify-mail-ui.mjs`): sign in, compose a text + image + poll post, react,
comment, open lightbox, follow a page, dark-mode + mobile viewport screenshots
into `.feed-ui-shots/`.

**Gate:** `npm run typecheck` (all workspaces) + `npm run build` +
`npm test` + `npm run verify:feed` all green.

---

## 9. Deployment

Same as Chat/Mail — no new services, no new infra:

1. `npm run build` on the runner (adds `@tupo/feed` to the root `build`
   fan-out; `apps/*` unchanged in count).
2. `rsync` build to the two Tupo subdomain hosts (per the Tupo production
   deploy memory), **without** pruning dev deps.
3. `npm run db:migrate` — applies `0017_feed.sql` (forward-only, transactional).
4. `npm run db:seed` — creates the three starter pages (idempotent).
5. `pm2 reload ecosystem.config.cjs` — api, realtime, worker pick up
   `@tupo/feed`; web is static.
6. Smoke: `GET /api/feed` 200 authed / 401 anon; publish a post from **NGA
   Official**; confirm it streams to a second session.

`ecosystem.config.cjs` needs no change (worker already runs sweeps; the feed
sweep registers alongside the mail one).

---

## 10. Build order

1. `0017_feed.sql` + migrate against `tupo_dev`.
2. `packages/shared`: `feed.ts` + `feedEvents.ts` + wire into `events.ts`/`index.ts`; build.
3. `packages/feed`: package skeleton → `pages` → `posts` → `feed` → `comments`
   → `reactions`/`polls`/`views`/`bookmarks` → `moderation`/`analytics`; build.
4. `apps/api/routes/feed.ts` + mount + notify wiring; `feed.test.ts`; build+test.
5. `apps/realtime/feed/handlers.ts` + register; build.
6. `apps/worker`: register `publishDueScheduledPosts` sweep; build.
7. `packages/db/src/seed.ts`: starter pages.
8. `apps/web/src/pages/feed/*` + routes in `App.tsx`; typecheck + build.
9. `scripts/verify-feed*.mjs`; run against `npm run dev`.
10. Screenshots, docs status table, deploy.

---

## 11. Status — built, 4 September 2026

| Area | Result |
|---|---|
| Migrations `0017_feed.sql` + `0018_feed_event_rsvps.sql` | ✅ apply clean, idempotent on re-run |
| `packages/shared` — `feed.ts` + `feedEvents.ts` wired into `events.ts`/`index.ts` | ✅ builds |
| `@tupo/feed` package (pages, posts, feed merge, comments, reactions, polls, engagement, moderation, analytics) | ✅ builds |
| `apps/api/routes/feed.ts` mounted at `/api/feed` (35 endpoints) | ✅ builds |
| `apps/realtime/feed/handlers.ts` — `feed:subscribe` + generic relay reuse | ✅ builds |
| `apps/worker` — `feed:sweep` every 30 s | ✅ builds |
| `apps/files` — `canReadFile` extended with a `feed` grant | ✅ builds |
| `packages/db/seed.ts` — 3 starter pages (NGA Official mandatory+verified, Academics, Sports & Clubs) | ✅ seeds idempotently |
| `apps/web/src/pages/feed/*` — provider, composer, post card, media lightbox, polls, events, comments, reactions with picker + burst, highlights bar, page profile, directory, insights, moderation queue, saved, permalink | ✅ typechecks + builds (392 kB gzip bundle) |
| Routes in `App.tsx` under `/app/feed` (gated on `FEED_VIEW`) | ✅ |
| `apps/api/src/__tests__/feed.test.ts` | ✅ **16/16** — full suite **210/210** |
| `npm run verify:feed` (live, against `npm run dev`) | ✅ **17/17** — perms, socket fan-out, reactions, comments, audience scoping, worker sweep, moderation remove, mandatory follow |
| `npm run verify:feed:ui` (Playwright) | ✅ **9/9** — compose, react, comment, directory, page profile, mobile, no horizontal overflow; screenshots in `.feed-ui-shots/` |
| `npm run typecheck` / `npm run build` (all 11 workspaces) | ✅ zero errors |

**Deployed 4 September 2026** — live at https://tupo.amashuri.com. Pushed by
hand over the pem key (rsync → `npm ci && npm run build && db:migrate &&
db:seed && pm2 reload` on the EC2 box), since the work sits on branch
`feat/feed-phase-4` rather than `main`. `0017`/`0018` applied to `tupo_prod`,
3 starter pages seeded, all four services 200, realtime handshake OK, and
`node scripts/verify-feed.mjs` passes **17/17** on the box. Merge
`feat/feed-phase-4` → `main` so the deploy Action and the repo of record catch
up.
