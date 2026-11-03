# Tupo (NGA Communication Module): Gap Analysis Report

| | |
|---|---|
| **Date** | 12 October 2026 |
| **Codebase** | `nga-communication-module` at `main` @ `0eb00ec` (after PR #32, the responsive pass) |
| **Scope** | Chat, Mail, Feed (with Reels and Stories), Meet, Notifications, Realtime gateway, Files service, Auth/SSO/RBAC, Admin, Search, PWA, UX/responsiveness/accessibility, Ops and testing |
| **Baseline** | `docs/TUPO_SRS.md` and the per-module implementation plans in `docs/` |
| **Method** | Static review of every module, then automated suites, then live probes (real sockets for several users and devices, plus Playwright two-browser tests) against a locally running stack |
| **Evidence folder** | [`docs/gap-analysis-2026-10-12/`](gap-analysis-2026-10-12/) (screenshots and raw probe results) |

---

## 1. Executive summary

Tupo has a lot of working functionality. The core chat realtime path, presence, multi-device sync, the offline outbox, oversight, SSO and the admin dashboard all work. More than 640 live backend checks pass. Every page renders without horizontal scrolling at 360, 768 and 1440 px.

The review still found **serious problems in security, data visibility and resilience**. Several of them can be exploited by a student account today. Each item below was **reproduced live during this review**:

| # | Problem | Who can trigger it | Impact |
|---|---|---|---|
| 1 | **Chat and meetings stop on 1 Nov 2026.** `messages` and `meeting_events` partitions only exist up to `2026_10`, and nothing creates new ones. An insert dated 1 Nov fails with `no partition of relation "messages" found for row`. | Time | Every chat message, system notice, poll and meeting event fails. **19 days from today**, if production matches the local DB (prod was migrated 21 Aug, so the same three months are expected). |
| 2 | **One request crashes the API.** `GET /api/meet?limit=x` is an unhandled rejection, so the process exits. | Any signed-in user, including students | Repeatable denial of service on the shared EC2 box. |
| 3 | **One socket event crashes the realtime gateway.** `meet:question_upvote` with a bogus id is an unhandled foreign-key error, so the process exits. | Anyone in a meeting, including a lobby guest | Every chat, presence and meeting socket drops. |
| 4 | **SQL injection in Mail.** `GET /api/mail/threads?folder=x' OR '1'='1` returns other users' threads. | Any user (students included) | Reads mail metadata across the school. Boolean-blind extraction of any table is possible. |
| 5 | **Stored XSS in Mail.** The body HTML is stored raw and rendered with `dangerouslySetInnerHTML`. The payload **executed** in the recipient's browser. | Any staff member (MAIL_SEND) | Session theft. The Tupo JWT in `localStorage` embeds the **MIS token**, so this becomes takeover across MIS, TaskMentor and the other apps. |
| 6 | **Drafts and scheduled mail appear in recipients' inboxes immediately.** | Any sender. Students can also push subjects into staff inboxes through "drafts". | Embargoed results leak. Half-written subjects show up. Students get round the MAIL_SEND restriction. |
| 7 | **Staff-only feed posts are pushed to students** over the socket and as notifications. Students can also comment on and react to staff-only posts, and list their comments. | Any follower | Breach of the audience rules and of safeguarding. |
| 8 | **Edit history IDOR.** A user can read the original text of messages in DMs they are not part of. | Any user | Private message content leaks, including content edited away. |
| 9 | **Fake "system" messages.** The client chooses `type: 'system'`, and the result **cannot be deleted** by the owner. | Any member (students included) | Official-looking notices that cannot be removed. |
| 10 | **Removed members keep receiving the conversation** on their open socket. | Removed users | Confidentiality of the group after removal. |
| 11 | **Meetings readable by anyone.** Details, recordings list, ICS and AI artefacts of an invite-only meeting return 200 to an uninvited student. | Any user | Meeting privacy. AI minutes leak. |
| 12 | **No rate limiting anywhere.** 60 chat messages and 40 feed comments in one burst were all accepted. | Any user | Spam and flood risk. Paid AI endpoints can be abused. |

**Feature gaps users will notice.**
- The **notification bell is a placeholder.** It has a permanently red dot, no panel, and the web app never calls `/api/notifications`.
- **Meet and Feed notifications never reach users.**
- There is **no Web Push**, so nothing arrives when the tab is closed.
- There is **no unread badge for Mail** (or any module other than Chat) in the navigation.
- **Files** is a "Coming Soon" page.
- **Block/report users** does not exist.
- Meet **breakout rooms** are not wired up on the client.
- **Drafts and scheduled feed posts cannot be found again** after saving.
- There is **no i18n**. The SRS requires English, Kinyarwanda and French.

### Scorecard

Green = solid, Amber = works with notable gaps, Red = broken or exploitable.

| Area | Function | Realtime | Security | UX / a11y | Overall |
|---|---|---|---|---|---|
| Chat | 🟢 | 🟡 | 🔴 | 🟡 | 🟡 |
| Mail | 🟡 | 🟡 | 🔴 | 🟡 | 🔴 |
| Feed | 🟡 | 🔴 | 🔴 | 🟡 | 🔴 |
| Meet | 🟡 | 🔴 | 🔴 | 🟡 | 🔴 |
| Notifications | 🔴 | 🟡 | 🟡 | 🔴 | 🔴 |
| Realtime gateway | 🟢 | 🟢 | 🔴 | n/a | 🟡 |
| Files | 🟡 | n/a | 🔴 | 🔴 (no UI) | 🔴 |
| Auth / SSO / RBAC | 🟢 | n/a | 🟡 | 🟢 | 🟢 |
| Admin (dashboard, oversight, audit) | 🟢 | 🟢 | 🟡 | 🟢 | 🟢 |
| Responsiveness | 🟢 | n/a | n/a | 🟡 | 🟢 |
| Ops / CI / tests | 🟡 | n/a | 🟡 | n/a | 🟡 |

### Totals

About **230 distinct findings**:

| Severity | Count | Notes |
|---|---|---|
| Critical | 17 | 12 reproduced live |
| High | 49 | |
| Medium | ~95 | |
| Low | ~70 | |

The detail is in §4–§11. Each item is tagged ✅ **Verified live** (reproduced against the running stack) or 🔍 **Code-verified** (traced in source with file:line evidence).

---

## 2. Test execution summary

### 2.1 Automated suites (existing)

| Suite | Result | Notes |
|---|---|---|
| `npm run typecheck` | ✅ passes after the local packages are rebuilt | On a fresh checkout it fails (`@tupo/notify` has no `profileMedia`, `UserProfile.coverUrl`) because `apps/*` type-check against stale `packages/*/dist`. **Gap:** typecheck should build its dependencies first (TS project references or a `prebuild`). |
| Unit tests, `apps/api` (vitest) | 470 passed, 23 skipped, **1 failed** | `feed.test.ts › a team member can carry a title`: expects 409 when demoting the last owner, gets 200. **Bug in the test, not the product.** An earlier test adds "Olga" as a second owner and never removes her (order-dependent state). In the full parallel run the whole file also failed to load. |
| Unit tests, other workspaces | 78 passed | `@tupo/feed` has **no test files** (`vitest run` exits 1, which also fails `npm test`). |
| `verify` | 8/8 ✅ | |
| `verify:chat` | 51/51 ✅ | |
| `verify:chat:live` | 43/43 ✅ | |
| `verify:presence` | 22/22 ✅ | |
| `verify:chat:threads` | 35/35 ✅ | |
| `verify:chat:files` | 42/42 ✅ | |
| `verify:chat:notifications` | 34/34 ✅ | |
| `verify:chat:power` | 54/54 ✅ | |
| `verify:chat:admin` | 52/52 ✅ | |
| `verify:mail` | 47/47 ✅ | Does not cover the draft/scheduled leaks, SQLi or XSS. |
| `verify:feed` | 17/17 ✅ | |
| `verify:oversight` | 32/32 ✅ | |
| `verify:notifications` | 11/11 ✅ | |
| `verify:meet` | 136 ✅, 1 skipped | |
| `verify:meet:history` | 5 ✅ / **2 ❌** | Test-harness rot: no `/api/sso/verify-mis` stub, so the page bounces to `/`. |
| `verify:meet:prejoin` | **0 / 1 ❌** | Same harness rot. |

> **Gap:** none of these suites run in CI. `deploy.yml` deploys straight to production on push with no lint, typecheck, test or audit step.

### 2.2 New probes written for this review

Three probe scripts were added under `scripts/`. They are reusable as regression gates and each cleans up its own users.

| Probe | What it does | Result |
|---|---|---|
| `scripts/gap-realtime-probe.mjs` | 4 users, 5 sockets (one user on 2 devices). Chat, typing, reactions, read sync, mail realtime, mail security, feed audience, feed broadcast payloads, presence, reconnect, rate limits. | **40 ✅ / 19 ❌** |
| `scripts/gap-ui-probe.mjs` | Two real browsers (actor and observer). Live chat, typing, offline/outbox, mail live updates and XSS, feed live updates. Responsive and a11y sweep of 13 pages × 3 viewports. | **19 ✅ / 3 ❌**, plus the sweep table |
| `scripts/gap-security-probe.mjs` | Chat integrity (system spoofing, IDORs, announcement bypass, removed-member socket), Meet access control, crash resilience. | **5 ✅ / 11 ❌** |

Run each with `npm run dev` up. Raw outputs are in `docs/gap-analysis-2026-10-12/*.json`.

---

## 3. What works well (verified live)

Recorded so it is not regressed while the gaps are fixed.

- **Chat realtime core.** In both the browser and the protocol tests:
  - A new DM appears in the other person's sidebar without a reload.
  - Messages reach **both devices** of the recipient and echo to the sender's other devices.
  - Reactions, edits and deletes render live.
  - The typing indicator appears while typing.
  - A message typed in one browser renders in the other.
- **Read sync across devices.** Marking read on device 1 sends `conversation:unread` and `read:update` to device 2, the sender receives `read:update`, and `/unread` drops from 2 to 0.
- **Offline handling (short outages).** The offline banner shows. A message sent while offline is delivered after reconnect (IndexedDB outbox). A message received during a short blip appeared after reconnect. Longer outages were not tested; see CHAT-H4.
- **Authorization on the chat core.** A non-member gets 404 on read and react. A non-member socket cannot subscribe and eavesdrop. B cannot edit A's message (403). Students cannot start DMs with staff (policy 403).
- **Presence.** A user stays online while one device remains. When the last device leaves, others see `offline` with `lastSeenAt`.
- **Mail delivery.** In-app delivery is live (`notification:new` arrives). The open inbox shows new mail without a reload. A reply into the open thread rendered live. Non-recipients get 404 on threads.
- **Feed.** Staff-only posts are refused to students on the comment, react and list routes *by REST URL*. (The leak is through the socket and audience-agnostic engagement routes; see FEED-A1.)
- **Responsiveness.** No horizontal page overflow on any of the 13 main pages at 360, 768 or 1440 px. Every page loads in about 1.8–2.9 s on dev. There were no JS page errors.
- **Architecture strengths.**
  - Chat sends deduplicated by nonce.
  - Seq allocated under a row lock.
  - Membership checked by the DB on every REST call.
  - `RichText` and the feed renderer never use `dangerouslySetInnerHTML`.
  - SSRF-hardened link unfurling.
  - Oversight preserves deleted content for review.
  - Single sign-out with RS256 and replay protection.
  - SSO-only login.
  - Permissions re-read from the DB on every request.
  - Invite codes are 128-bit.
  - The worker uses BullMQ jobs with fixed jobIds.

---

## 4. Cross-cutting critical issues

These cut across modules and should be fixed first.

| ID | Sev | Finding | Evidence | Status | Recommendation |
|---|---|---|---|---|---|
| X-01 | **Critical** | **Partitions run out.** `messages` and `meeting_events` are range-partitioned by `created_at`. Partitions are created once at migration (current month + 2) with **no maintenance job and no DEFAULT partition**. Locally only `*_2026_08/09/10` exist. | `packages/db/migrations/0002_message_partitions.sql`, `0004_meet.sql:107-125`. Live: `INSERT … created_at='2026-11-01'` gives `ERROR: no partition of relation "messages" found for row`. | ✅ Verified live (local) | **Today:** check prod with `SELECT relname FROM pg_class WHERE relname ~ '^(messages\|meeting_events)_20'` and create Nov/Dec/Jan partitions by hand. **Then:** add a worker cron that keeps N+3 months ahead, plus a DEFAULT partition as a safety net and an alert. |
| X-02 | **Critical** | **API crashes on unhandled async errors.** Express 4 with no async wrapper on `meet.ts`, `users.ts`, `audit.ts`, `notifications.ts`, `rolesPermissions.ts`, and `authMiddleware` itself. There is no `process.on('unhandledRejection')`, so Node 22 exits. | `GET /api/meet?limit=x` → `invalid input syntax for type bigint: "NaN"` → API down. Also `apps/api/src/middleware/auth.ts:41,66`, `routes/meet.ts:378`, `users.ts:60`, `audit.ts:11`. | ✅ Verified live | Use `express-async-errors` or Express 5, or the shared `wrap()` everywhere. Validate numeric query params. Add try/catch in `authMiddleware`. Log `unhandledRejection` as a last resort. |
| X-03 | **Critical** | **Realtime gateway crashes on unhandled async errors in socket handlers.** | `apps/realtime/src/meet/namespace.ts:888-896` (`meet:question_upvote` with a fake id gives an FK violation and the process exits). Also `meet:poll_create`, `disconnect → fetchSockets()`. | ✅ Verified live | Wrap every handler (a `safe(handler)` helper), validate payloads with zod, add a process-level handler. |
| X-04 | **Critical** | **Files service crashes.** Raw async handlers. `limit=x` gives NaN. A missing file on disk raises an unhandled stream error. | `apps/files/src/index.ts:302,307,327`, `access.ts:249` | 🔍 Code-verified | Same fix as X-02. |
| X-05 | **High** | **No rate limiting** on chat (REST and socket), feed, mail compose, uploads, search, translate/AI, or socket events (`typing:start` costs 3 Redis calls plus a broadcast per event). | 60 parallel chat sends → `{"201":60}`. 40 feed comments → `{"201":40}`. grep finds no limiter apart from SSO exchange, meet guest join and MIS integration. | ✅ Verified live | Redis sliding-window limits per user and route, plus a per-socket `socket.use` limiter. Stricter limits on AI and compose. |
| X-06 | **High** | **"Personal state" is broadcast to everyone** in Chat, Feed and Meet. Payloads carry the actor's `mine`, `myVotes`, `canEdit`, `canModerate`, `saved`, `mentionsMe`, `bookmarked` and `event.going`, and clients replace objects wholesale. | Live: C's reaction broadcast to B carried `reactions.mine = "like"`. The feed comment broadcast carried `"canEdit":true`. Code: `routes/feed.ts:40-45,277,367`, `packages/chat/service.ts:1375`, `realtime/meet/namespace.ts:150-171`. | ✅ Verified live (payloads) | Broadcast neutral payloads and work out viewer state on the client from `userId`, or emit `{id}` and let each client refetch. |
| X-07 | **High** | **Stored XSS plus a token readable by JS, with no CSP.** The Tupo JWT lives in `localStorage` and embeds `misToken`. There is no CSP, HSTS or X-Frame-Options on the SPA (`infra/nginx/tupo.conf`). | See MAIL-C2. `apps/web/src/lib/api.ts:8,25`, `routes/sso.ts:218` | ✅ Verified live | Sanitise on write and on render. Strict CSP. Move to an httpOnly refresh cookie plus a short-lived access token. Stop embedding the MIS token in the browser token. |
| X-08 | **High** | **Test-data pollution.** Verify scripts leave feed pages ("brambl… news", "UI Demo", "Fix Verify") in the dev DB, visible in the page directory. | `docs/gap-analysis-2026-10-12/phone_app_feed_pages.png` | ✅ Verified live | Purge feed pages (and anything else they create) in each verify script's cleanup. |

---

## 5. Chat module

### 5.1 Critical and high

| ID | Sev | Finding | Evidence | Status | Recommendation |
|---|---|---|---|---|---|
| CHAT-C1 | Critical | **The client chooses the message `type` and `metadata`.** `type:'system'` is stored and renders as an official centred notice. It is **undeletable even by the group owner**. Fake `poll` and `call_event` cards are also possible, and metadata has no size limit. | Live: student post `type:system` → 201, stored `system`. Owner delete → 400 "System messages cannot be deleted." `handlers.ts:139-143`, `routes/chat.ts:486-496`, `service.ts:507` | ✅ Verified live | Allow-list client types (`text`, `file`, `voice_note`, `call_event` with server-written metadata). Validate metadata with a schema and size cap. Let moderators remove anything. |
| CHAT-C2 | Critical | **Edit-history IDOR.** The route checks membership of `:id`, but `editHistory()` filters by `message_id` only, and it returns history for deleted messages too. | Live: an outsider read `"PRIVATE ORIGINAL"` from an A↔B DM via their own conversation id. `routes/chat.ts:649-654`, `service.ts:1510` | ✅ Verified live | Join on `(conversation_id, id)`. Refuse deleted messages unless the reader has oversight. |
| CHAT-H1 | High | **Announcement channels can be bypassed** through `POST /messages/:id/replies` with `alsoSendToChannel`, and through forward. | Live: student thread reply in an announcement channel → 201. `routes/chat.ts:701`, `service.ts:1895` (forward). Note: `/scheduled` returned 403 only because students lack MESSAGE_SCHEDULE; staff members without a channel role are still unguarded there (code). | ✅ Verified live (reply) | One `assertCanPost()` guard used by send, reply, forward, schedule, poll and the scheduled worker. |
| CHAT-H2 | High | **Removed members keep receiving the conversation** over their open socket (messages, typing, reactions) until they reconnect. Nothing calls `socketsLeave`. | Live: after `DELETE /members/:id` → 200, the removed user's socket received `message:new` "AFTER-REMOVAL secret". `routes/chat.ts:1129-1156`, `handlers.ts:65-80` | ✅ Verified live | Relay an eviction: `io.in('user:X').socketsLeave('conv:Y')`, and emit a removal event to the user's room. |
| CHAT-H3 | High | **The typing indicator can stick.** The whole typing hash shares one 6 s TTL, refreshed by *anyone's* keystrokes, so stale entries survive. Expiry is silent (no broadcast). The web never sends `typing:stop` and has no client-side expiry. | Live: no expiry event within 9 s. `handlers.ts:301-318`, `packages/shared/src/events.ts:85`, `ChatProvider.tsx:325-331` | ✅ Verified live | Store a timestamp per user. Expire on the client 6–7 s after the last update. Send `typing:stop` on send, blur and clear. Broadcast on expiry. |
| CHAT-H4 | High | **No catch-up after a long disconnect.** `onConnect` re-subscribes and refreshes the conversation list only. The open thread is not refetched with `after=lastSeq`. There is no SRS §9.1 sync protocol (`sync:request/response/reset`) and no §9.3 polling fallback. | `ChatProvider.tsx:267-277`. Live note: a ~2 s blip recovered (the socket survived), but a real reconnect relies on the user switching conversations. | 🔍 Code-verified | On reconnect, fetch `messages?after=<lastSeq>` for the open conversation. Implement the sync protocol. |
| CHAT-H5 | High | **Conversations that are not open go stale.** Only the open conversation's room is joined, so other conversations get only `conversation:unread`. Sidebar previews, ordering, typing and edit/delete previews go stale. The dock has the same problem. | `ChatProvider.tsx:272,471-479` | 🔍 Code-verified (live: the first message's preview *did* update via announce) | Relay a compact `conversation:activity` (preview, lastSeq, at) to members' user rooms. |
| CHAT-H6 | High | **The thread panel is not live.** `thread:reply` is never handled. Updated, deleted and reaction events skip `threadMessages`. Thread replies are not optimistic and not saved to the outbox, so an offline reply is lost. | `ThreadPanel.tsx`, grep of `thread:reply` in web | 🔍 Code-verified | Handle `thread:reply`. Route update, delete and reaction events into the thread state. Use the outbox for replies. |
| CHAT-H7 | High | **Read receipts (FR-MSG-13) are mostly missing in the UI.** The web ignores `read:update` and `receipt:update`, so ticks only change on reload. It never emits `receipt:delivered`. `receiptsVisibleTo()` is never called (reciprocity not enforced). "Delivered" is worked out as "read by ≥1". | Live: A's socket *does* receive `read:update`, but the web has no handler. | ✅ Payload / 🔍 UI | Handle both events, emit delivered acks, enforce reciprocity, support a space-level policy. |
| CHAT-H8 | High | **Thread replies leave the unread badge stuck.** Replies increment unread, but the client marks read only up to the newest main-feed message. A fake `threadRootId` makes unread that can never be cleared. | `service.ts:579-589`, `MessageThread.tsx:757-766` | 🔍 | Leave thread replies out of unread, or mark read to `lastSeq`. Validate `threadRootId`. |
| CHAT-H9 | High | **The socket path is weaker than REST.** No audit on moderator delete. Contact policy is skipped for mentions. Edits allowed in archived conversations. Reaction notifications never fire. Thread fan-out is missing. | `handlers.ts:119-230` vs `routes/chat.ts:530,641,665` | 🔍 | Put each action and its fan-out in one shared service function used by both transports. |
| CHAT-H10 | High | **Forwarding is broken.** Forwarding someone else's attachment → 403 (owner check). "Forwarded from" is missing live. The comment message is not broadcast. Forwarding a poll creates an empty poll. | `service.ts:656,1895-1922` | 🔍 | Re-grant attachments on forward. Broadcast after `forwarded_from` is set. |
| CHAT-H11 | High | **Block and report (FR-USR-7) are entirely missing.** The `user_blocks` table exists but has no API or UI, and `sendMessage` ignores blocks. | grep | 🔍 | Build block/unblock/report in the API and UI, enforced in send, mentions, DM start and presence. |
| CHAT-H12 | High | **Scheduled messages are sent without re-checking.** No membership, archive, announcement or permission re-check. Rows stuck in `sending` after a crash are never recovered. Failed rows are invisible to the user. | `worker/jobs/scheduledMessages.ts:57`, `service.ts:2322-2350` | 🔍 | Re-check on send. Sweep stale `sending` rows. Show failures. |

### 5.2 Medium

| ID | Finding | Evidence |
|---|---|---|
| CHAT-M1 | Arbitrary strings accepted as reactions (`"<script>"` → 200; only >64 chars refused). They are also pushed into notification titles. | ✅ live; `service.toggleReaction` |
| CHAT-M2 | `getPollByMessage` ignores the conversation id (IDOR on polls and voter ids). `reactorNames` has the same pattern; it returned no names in the live test, but should still be scoped. | `routes/chat.ts:1017`, `service.ts:1398,2519` |
| CHAT-M3 | Thread replies notify followers as "mentioned you". `@channel`/`@here` are not role-gated, so a student's `@channel` adds a mention badge for every member. `@here` is not narrowed to present members. | `routes/chat.ts:731-742`, `resolveMentions` |
| CHAT-M4 | DND, quiet hours and `defaultLevel` are ignored server-side. Quiet hours run only in the browser, on the server clock, ignoring `prefs.timezone`. | `ChatNotificationBridge.tsx` |
| CHAT-M5 | Polls: no unread or notification on create; votes are not transactional (single-choice can get 2 votes); `closesAt` not validated (500); no length limits; votes accepted in archived channels; no event when a poll closes. | `routes/chat.ts:991-1055` |
| CHAT-M6 | The disappearing-message sweep emits no `message:deleted`, does not recount unread, and leaves translations, links and nonces behind (content stays readable as translations). `DELETE … id = ANY` scans every partition. | `service.ts:2990` |
| CHAT-M7 | **Missing index on `messages(conversation_id, id)`.** The PK is `(conversation_id, seq, created_at)`, so get, edit, delete, react, pin and context scan the whole conversation. | migrations |
| CHAT-M8 | `markRead` rewrites receipts for *every* message up to the watermark (O(N), and `message_receipts` grows to members × messages). `announceConversation` runs one query per member. | `service.ts:1082` |
| CHAT-M9 | Events are delivered N times with more than one realtime instance. Each instance subscribes to `tupo:chat` and calls `io.to().emit`, which the Redis adapter already fans out. Use `io.local`. | `realtime/index.ts:98-112` (suspected; production runs 1 instance today) |
| CHAT-M10 | Multi-tab presence: status is per socket, so an idle tab sets "away" while the active tab never re-reports. There is no busy/DND UI. "In a meeting" is never set. | `index.ts:312,389` |
| CHAT-M11 | Presence privacy: `presence:query` answers for any of 500 user ids and returns last-seen even for users who hid their presence. `viewing` includes hidden users. | `index.ts:405`, `presence.ts:57-67` |
| CHAT-M12 | The offline outbox is shared across accounts and never cleared on logout, so a message can be flushed as the next user. It drops `type`/`metadata`. One poisoned entry blocks the queue. Queued messages are not shown after a reload. | `outbox.ts` |
| CHAT-M13 | `retry` re-sends without attachments or metadata. `settle`/`failed` write into whichever conversation is now open (wrong-conversation bug). Failed socket reactions are not rolled back. | `ChatProvider.tsx:601-649` |
| CHAT-M14 | Jump-to-message leaves a gap with no "load newer". The search `open` races a `setTimeout(350)`. There is no jump-to-date (FR-MSG-16). | `SearchPanel.tsx:63-67` |
| CHAT-M15 | `useVirtualWindow` resets to the last 200 on every count change, so scroll position jumps (suspected). | `useVirtualWindow.ts` |
| CHAT-M16 | The draft echo is sent back to the same device, which overwrites in-progress typing or restores sent text. | `routes/chat.ts:399` |
| CHAT-M17 | The pinned bar goes stale (edits and deletes of pins never update it) and shows raw `<@id>` tokens. | `PinnedBar.tsx` |
| CHAT-M18 | "Archived" only blocks send and edit. Reactions, pins, votes and invites still work. Soft-delete with 30-day restore (FR-CHN-7) is missing. | |
| CHAT-M19 | Pinning needs only platform MESSAGE_PIN, not a channel role. Admins can demote other admins. The 500-member cap is not enforced. | |
| CHAT-M20 | Validation gaps that end in 500s: `mutedUntil`, `status.expiresAt`, `closesAt`, `replyToId`; draft, metadata and attachment count are unbounded. | |
| CHAT-M21 | Deleting a thread reply never decrements `reply_count`. Previews include raw `<@id>` tokens. | |
| CHAT-M22 | Link previews: pinned-IP plus `Host` header likely breaks HTTPS certificate checks (suspected). `og:image` is hot-linked, which leaks viewers' IPs. Edits do not re-unfurl. | `unfurl` |

### 5.3 Low, UX and accessibility

- **Touch hover toolbar:** it is `opacity-0` but still clickable, so taps can hit invisible buttons. There is no long-press menu (UX-7).
- **Errors look like empty states:** a failed message load shows "No messages yet" with no retry.
- **Dock badge:** it counts muted conversations, unlike the sidebar.
- **New-messages divider:** it disappears immediately on short threads. Messages that arrive while the tab is hidden are not marked read on `visibilitychange`.
- **Mobile dock:** it is a `role=dialog` with no focus trap, and it stays subscribed while closed, so the user shows as "viewing".
- **Search:** no pagination, no `from:`/`before:`/`has:` filters, no recent searches, no typo tolerance (FR-SRCH-2/4/7).
- **Conversation header:** the audio/video call buttons have **no `onClick`** (`MessageThread.tsx:167-171`).

### 5.4 SRS coverage (Chat)

| Requirement | Status |
|---|---|
| FR-MSG-1/2/4/6/7/9/10/11/12/15/17/19/21/22/23/25 | Implemented |
| FR-MSG-3 (math, code highlighting) | **Missing** |
| FR-MSG-5 (custom emoji, skin tones) | **Missing** |
| FR-MSG-8 (configurable edit window) | Hard-coded 24 h |
| FR-MSG-13 (receipts) | **Partial**, see CHAT-H7 |
| FR-MSG-14 (typing) | **Buggy**, see CHAT-H3 |
| FR-MSG-16 (jump to date) | **Missing** |
| FR-MSG-18 (scheduled edit, failure visibility) | **Partial** |
| FR-MSG-20 (voice-note transcoding) | **Missing** |
| FR-MSG-24 (offline pending UI) | **Partial** |
| FR-MSG-26 (`/remind /away /invite /archive`) | **Missing** |
| FR-USR-3 (statuses) | **Partial** |
| FR-USR-7 (block/report) | **Missing** |
| FR-CHN-7 (delete/restore) | **Missing** |
| FR-CHN-8 (guests) | **Missing** |
| FR-CHN-10 (custom sections) | **Missing** |
| SRS §9.1 sync protocol, §9.3 polling fallback | **Missing** |

---

## 6. Mail module

### 6.1 Critical and high

| ID | Sev | Finding | Evidence | Status | Recommendation |
|---|---|---|---|---|---|
| MAIL-C1 | **Critical** | **SQL injection via `?folder=`.** It is interpolated into SQL: `` `r.folder = '${opts.folder}'` ``. `threadSummary` has no participation check, so other users' subjects, snippets and emails are returned. | Live: a student calling `folder=x' OR '1'='1` → 200 with a foreign thread. `routes/mail.ts:66-68`, `packages/mail/src/service.ts:283-290,310` | ✅ Verified live | Allow-list against `MAIL_FOLDERS` and return 400 otherwise. Use bind parameters. Add a participation check in `threadSummary`. Add regression tests. |
| MAIL-C2 | **Critical** | **Stored XSS.** `compose`, templates and campaigns store HTML raw. It is rendered with `dangerouslySetInnerHTML` in `ThreadView.tsx:110`, `MailCampaigns.tsx:179` and `AiAssistant.tsx:126`. There is no DOMPurify. The forward header also interpolates `from.name`/`subject` unescaped. | Live: `<img src=x onerror=…>` **executed in the recipient's browser** (`window.__xss=1`, alert fired). The API returns `onerror`, `javascript:` and `<script>` verbatim. Screenshot: `gap-analysis-2026-10-12/mail-xss.png`. | ✅ Verified live | Sanitise on write (e.g. `sanitize-html` with an allowlist matching TipTap output). Use DOMPurify or a sandboxed iframe on render. Add a CSP. Sanitise campaign and template bodies and outbound SMTP HTML. |
| MAIL-C3 | **Critical** | **Drafts create live inbox rows for recipients.** The half-written subject appears unread in the recipient's inbox (autosave every 4 s). Drafts need only MAIL_READ, so **students and parents can push subjects into anyone's inbox**, bypassing MAIL_SEND. | Live: draft "HALF-WRITTEN DRAFT" visible in the recipient's inbox. Student draft "STUDENT DRAFT SPAM" visible in a staff inbox. `service.ts:627-636,687-702`, `routes/mail.ts:115-121` | ✅ Verified live | Do not create recipient rows for drafts (keep recipients as JSON on the draft), or filter `NOT is_draft AND sent_at IS NOT NULL` in every mailbox, count, search and attachment query. |
| MAIL-H1 | High | **Scheduled mail is visible before its send time.** Recipient rows and the thread summary are written at compose time. | Live: "EMBARGOED RESULTS" scheduled for +3 days was visible in the recipient's inbox at once. `service.ts:688-720` | ✅ Verified live | Make recipient rows visible only once delivered. Update the thread summary in `sendDueScheduled`. |
| MAIL-H2 | High | **Thread-level access leaks messages not addressed to the viewer.** Anyone who ever participated sees *every* later message: a private reply to one person, all reply-all traffic seen by a BCC'd recipient. The same applies to AI summaries and global search. | `service.ts:395-425,537-557`, `routes/search.ts:208-230` | 🔍 | Filter visibility per message (sender, or holder of a non-hidden recipient row). |
| MAIL-H3 | High | **"Continue editing" a draft wipes its recipients and attachments** on the first autosave, and a draft reply becomes `kind='new'`. | `ThreadView.tsx:296`, `Composer.tsx:79`, `service.ts:656-657` | 🔍 | Seed the composer with the full message (to, cc, bcc, attachments, parentId, kind). |
| MAIL-H4 | High | **SMTP dispatch is not safe against concurrent runs.** No atomic claim across `mail:send`, the 30 s sweep and campaign inline sends (concurrency 5), so duplicate external emails are possible. Rows crashed in `sending` are stranded. `runCampaign` never resumes `sending` campaigns. Errors are swallowed, so BullMQ retries never apply. | `delivery.ts:128-161`, `campaigns.ts:312-325,449-455`, `worker/index.ts:138` | 🔍 | Claim with `FOR UPDATE SKIP LOCKED`. Reclaim stale rows. Use a campaign lease. Exponential backoff with `next_attempt_at`. |
| MAIL-H5 | High | **Any SMTP 5xx is treated as a recipient bounce and suppresses the address permanently.** A wrong relay password (535) or relay-denied would suppress *every* recipient. | `smtp.ts:97-102`, `delivery.ts:182-190` | 🔍 | Suppress only on RCPT-level 5.1.x errors. Treat auth and connection errors as transport failures and alert. Never auto-suppress internal users. |
| MAIL-H6 | High | **The >200-recipient approval (FR-MAIL-10) can be bypassed.** List membership is re-resolved at run time without a re-check. Direct compose allows 200 recipients per message with no rate limit (10 calls reach the whole school). | `campaigns.ts:241-246,329`, `shared/mail.ts:46` | 🔍 | Freeze a recipient snapshot at approval. Per-user hourly and daily recipient caps. |
| MAIL-H7 | High | **Distribution-list members (addresses and merge vars) are readable by any user,** including students. | Live: a student's `GET /lists/:id/members` → 200 ("All Parents"; empty in dev). `routes/mail.ts:232-234`, `lists.ts:87-97` | ✅ Verified live | Require MAIL_LIST_MANAGE or MAIL_BULK_SEND. Leave out `merge_vars`. |
| MAIL-H8 | High | **Merge values are inserted into HTML unescaped** (`escape:false`), which is XSS in campaigns. Merge keys are case-sensitive, so `{{Class}}` renders blank. | `campaigns.ts:200,378`, `render.ts:18-20` | 🔍 | `escape:true` for HTML. Lower-case keys on write. |
| MAIL-H9 | High | **Later replies in a thread raise no new unread notification.** The notification upsert keeps `read_at` (keyed on thread). | `delivery.ts:89-97`, `packages/notify/src/index.ts` ON CONFLICT | 🔍 | Key the notification per message, or reset `read_at` on refresh. |
| MAIL-H10 | High | **No unread-mail badge in the navigation.** On another module the Mail nav item shows just "Mail". | Live: nav text `"Mail"` after a new mail arrived. `AppShell.tsx` `RailLink badge` never passed. Screenshot `nav-after-mail.png` | ✅ Verified live | Feed `mailboxCounts.inbox` into the rail and tab badges, updated by `notification:new` (mail kinds). |

### 6.2 Medium

| ID | Finding | Evidence |
|---|---|---|
| MAIL-M1 | **The unread count is inflated.** It counts recipient *rows*, not threads, and with `MAIL_INTERNAL_EMAIL=on` (as in prod) each internal recipient has an `in_app` and an `smtp` row, so every mail counts **twice**. The thread header lists the recipient twice ("to Ben Probe, Ben Probe"). | ✅ Live: 1 mail → inbox count 2; 3 threads → badge **6** (`mail-xss.png`). `service.ts:175-179,226-228,494-495` |
| MAIL-M2 | The Sent folder floods with one thread per campaign recipient. The mailbox loads every row with no LIMIT, sorts in JS, and runs about 90 queries per page. The cursor can repeat or drop threads. | `service.ts:267-306`, `campaigns.ts:381-396` |
| MAIL-M3 | Read state does not sync: opening a thread marks it read, but the sidebar counts, bold rows, the `mail.received` notification and **other devices** are not updated. | ✅ Live: no socket event on device 2 after read. `ThreadView.tsx:174-189` |
| MAIL-M4 | The campaign editor shifts the scheduled time by the timezone offset (UTC ISO put into `datetime-local`): −2 h per edit in Kigali. The composer's `min` uses UTC, so past local times are allowed. | `MailCampaigns.tsx:45,80`, `Composer.tsx:279` |
| MAIL-M5 | `previewCampaign` forces `canSeeAll=true`, so any bulk sender can preview anyone's campaign. | `campaigns.ts:183` |
| MAIL-M6 | Approvers get no notification in `shadow`/`off` mode. Approve is one click with no content preview. Reject uses `window.prompt`. | `MailCampaigns.tsx:247-256` |
| MAIL-M7 | No SMTP rate limit: `MAIL_SMTP_RATE_PER_MIN` is defined but never used (FR-MAIL-7). | `smtp.ts:50-54` |
| MAIL-M8 | No async bounce or complaint handling. "Delivered" means "relay accepted". `bounced` is always 0. No `List-Unsubscribe`, `Message-ID`, `In-Reply-To` or `References` headers. | `delivery.ts:172-179`, `smtp.ts:86-94` |
| MAIL-M9 | External recipients never receive attachments. | `delivery.ts:162-170` |
| MAIL-M10 | Forward drops attachments, and forwarding a received attachment fails the owner check. Attachment name, mime and size are trusted from the client. | `ThreadView.tsx:203-208`, `service.ts:675-684` |
| MAIL-M11 | Archive and Delete on Sent, Drafts and Scheduled return 404 (no recipient rows), and the error is swallowed. **Bulk delete in Trash is a no-op** (`folder==='trash' ? 'trash' : 'trash'`). | `MailList.tsx:86,163-165` |
| MAIL-M12 | Reply, Forward and Compose are shown to users without MAIL_SEND, who then get a 403. Reply-all includes yourself. "Reply" on your own sent mail addresses yourself. | `ThreadView.tsx:51-52,126-133` |
| MAIL-M13 | Autosave races create duplicate drafts. There is no idempotency key. Send is not disabled during uploads. | `Composer.tsx:74-85` |
| MAIL-M14 | No limits on `/compose` or the paid `/ai/*` endpoints. | |
| MAIL-M15 | Mailbox search covers only subject and snippet (unindexed ILIKE). | `service.ts:292` |

### 6.3 Low

- `createList` accepts any `origin`.
- `/lists/:id/sync` runs twice (once inline, once enqueued).
- The MIS sync deletes and re-inserts the whole list every 15 minutes.
- Campaign notification links go to `/app/mail/campaigns/:id`, a route that does not exist.
- Silent 200 KB HTML truncation.
- `kind` and `parentId` are not validated.
- Non-transactional campaign materialisation, with no unique `(message_id, address, channel)`.
- Any bulk sender can remove complaint suppressions.
- Seeded templates are editable by anyone.
- `GET /threads/:id` has a side effect (marks the thread read).
- The Spam folder is never used.
- Trash has no retention purge.
- The directory exposes every user's email.
- The SRS API (`POST /mail`, `/mail/bulk`) does not match the implemented routes.

### 6.4 UX and accessibility

- **Keyboard and screen readers:**
  - Thread rows are clickable `<div>`s: not focusable, no listbox semantics, unread shown only by font weight, unlabelled checkboxes.
  - The label delete button only appears on hover.
  - The composer has no `role=dialog`, no focus trap, no Esc or Ctrl+Enter, and no j/k/e/r shortcuts.
  - The recipient picker lacks combobox ARIA.
- **Missing features:** no undo send, no "draft saved" indicator, no warning when leaving with unsaved changes, no swipe actions on mobile, and the inline reply has no Cc, attachments or quoted text.
- **Error handling:**
  - `MailList.load` has no catch.
  - Any `ThreadView` error shows "Thread not found".
  - Archive and Delete have no error handling.

### 6.5 SRS coverage (Mail)

| ID | Status | Main gaps |
|---|---|---|
| FR-MAIL-1 | Partial | C3, H1, M11, M12 |
| FR-MAIL-2 | Partial | No subject normalisation, no References headers |
| FR-MAIL-3 | Partial | No scan check, no SMTP attachments, `MAIL_MAX_ATTACHMENT_BYTES` unused |
| FR-MAIL-4 | Partial | No "parents of class 4B" from MIS |
| FR-MAIL-5 | Partial | Merge fields limited to name, email and role; H8 |
| FR-MAIL-6 | Done | Templates work |
| FR-MAIL-7 | Partial | No rate limit, wrong bounce handling |
| FR-MAIL-8 | Partial | "Delivered" overstated, bounces folded into failed |
| FR-MAIL-9 | Done | In-app delivery plus notification |
| FR-MAIL-10 | Partial | H6 bypasses |
| FR-MAIL-11 | **Not implemented** | External replies are not ingested |

---

## 7. Feed module (posts, pages, reels, stories)

### 7.1 Critical and high

| ID | Sev | Finding | Evidence | Status | Recommendation |
|---|---|---|---|---|---|
| FEED-S2 | **Critical** | **Staff-only posts are pushed to student followers:** `feed:post_new` with the full body over the socket, plus a `feed.published` notification and push. | Live: the student socket received the "STAFF ONLY probe" body and a notification. `routes/feed.ts:192,224,540-561` | ✅ Verified live | Filter followers by `visibleAudiences(roleLevel)`, or emit only to the audience room. |
| FEED-A1 | **Critical** | **Engagement endpoints skip the audience check (and some skip the status check).** Students can **comment on, react to, and list comments of staff-only posts.** Also affected: `listReplies` (no post check), `reactToComment`, `votePoll`, `rsvpEvent`, `bookmark`, `recordView`, `recordShare`, and the reel like, comment and view routes. | Live: student comment → **201**, list → **200**, react → **200** on a staff-only post. `pkg/comments.ts:65-73,172,212-229`, `reactions.ts:26-30,98-102`, `polls.ts:14-19`, `engagement.ts`, `reels.ts:82-231` | ✅ Verified live | One `loadVisiblePost(actor,id)` guard (published, not deleted, page not deleted, audience visible) used by every engagement path. |
| FEED-S1 | High | **Any page owner can make any file readable by everyone.** `avatarFileId`/`coverFileId` are stored without ownership checks, and the files service lets everyone read page avatars and covers. | `pkg/pages.ts:190-193,304-305`, `apps/files/src/access.ts:140-142` | 🔍 | Validate with `resolveMedia` (owner, ready, image mime). |
| FEED-R1 | High | **Live events overwrite every viewer's personal state** (`canEdit`, `canPin`, `reactions.mine`, `bookmarked`, `event.going`, `page.following`). After an edit or RSVP, every viewer appears as "going" or sees Edit/Delete. | Live: payload `canEdit:true` on the comment broadcast; reaction `mine` leaked (X-06). `routes/feed.ts:40-45,189-196`, `FeedProvider.tsx:104-110` | ✅ Payload verified | Neutral broadcasts, with viewer fields merged on the client. |
| FEED-R2/R3 | High | **Reaction and poll broadcasts carry the actor's `mine`/`myVotes`.** The viewer's next tap sends the wrong mutation, and poll results show to people who have not voted. | as above; `pkg/reactions.ts:62-89`, `polls.ts:73` | ✅ Payload verified | Strip personal fields. |
| FEED-A2 | High | **Page editors and admins can edit the text of anyone's comment** (impersonation). | `pkg/comments.ts:246-258` | 🔍 | Edit: author only. Moderators: delete only. |
| FEED-F1 | High | **Drafts, scheduled and unpublished posts cannot be found once saved.** There is no listing endpoint and `api.publishPost` is never called. "Save draft" and "Move to drafts" effectively lose the post (FR-FEED-4). | `pkg/feed.ts`, `Composer.tsx:307`, `PostCard.tsx:139-141` | 🔍 | `GET /pages/:id/posts?status=…` for editors, a "Drafts & scheduled" tab, and publish/reschedule actions. |
| FEED-B1 | High | **A malformed `linkPreview` crashes the feed for every viewer** (stored DoS). The client-supplied preview is stored unvalidated and `new URL(preview.url)` throws in render. The image loads from any host (tracking pixel). | `pkg/posts.ts:194,326`, `PostCard.tsx:259-264` | 🔍 | Generate previews on the server (reuse `unfurlLinks`). Validate http(s). Add an error boundary per card. |
| FEED-L1 | High | **The permalink page receives no live updates.** A comment by another user did not appear on `/app/feed/post/:id`. Posts revealed from the "new posts" pill, and the author's own new post, are not subscribed either. | ✅ Live: `LIVE-FEED-COMMENT` not shown within 6 s. `FeedHome.tsx:38-53` (no `watch`) | ✅ Verified live | Call `watch()` on permalink mount, pill reveal and own publish. |

### 7.2 Medium

| ID | Finding | Evidence |
|---|---|---|
| FEED-B2 | Posts from deleted pages still show in the home feed, following and bookmarks (search filters them correctly). | `pkg/pages.ts:325-328`, `posts.ts:424` |
| FEED-B3 | **Scheduled posts go live silently:** no `feed:post_new`, no follower notification. No `SKIP LOCKED`. A post unpublished between select and update can still be published. | `pkg/posts.ts:598-619` |
| FEED-B4 | Single-select polls can record two votes under a race (delete-then-insert). | `pkg/polls.ts:31-37` |
| FEED-B5 | Socket subscriptions stop after 200 posts per session (the client never unsubscribes). `feed:subscribe` has **no access check**, so anyone can join a staff-only post's room. | `FeedProvider.tsx:90-97`, `realtime/feed/handlers.ts:16-42` |
| FEED-B7 | Replies appear twice for their author (the socket dedup covers only top-level comments). `replyCount` goes up by 2. | `Comments.tsx:32-36,72-73` |
| FEED-B8 | Live comment edits never render (the body is copied to state once). | `Comments.tsx:95` |
| FEED-B9 | Comment counts drift after deletes (cascaded replies are not counted). | `FeedProvider.tsx:118`, `comments.ts:272` |
| FEED-B10 | Counter races: `SET x = (SELECT count(*))` under READ COMMITTED. `reactions.total` and `byEmoji` can disagree. | `reactions.ts:50-53`, etc. |
| FEED-B11 | **View counts can be inflated:** each `POST /view` adds 1 (live: 3 calls → `viewCount=3`). Shares are not deduplicated. Each view takes a row lock and broadcasts. | ✅ Live. `engagement.ts:21-35,59-67` |
| FEED-B12 | `post_count` drifts on deleting drafts or unpublished posts. | `posts.ts:279-292` |
| FEED-B13 | An audience change on edit is not re-broadcast, so old subscribers keep receiving updates. | `posts.ts:327-330` |
| FEED-B14 | `ensureMandatoryFollows` runs an UPDATE on every feed load (lock contention on hot rows). | `pages.ts:477-480` |
| FEED-P1 | The "all" feed scans and sorts every visible post on each request. Fan-out is bypassed (FR-FEED-7). | `pkg/feed.ts:98-115` |
| FEED-P2 | Unbounded queries and N+1s: poll votes, reply loading, the moderation queue, reel comments, `getViewers`. | |
| FEED-P3 | Missing index `feed_timeline(post_id)`. | |
| FEED-P4 | Follower notifications run synchronously in the publish request. For mandatory pages that is the whole school (timeouts). | `routes/feed.ts:553-559` |
| FEED-V1 | `status`, `commentPolicy` and `poll.closesAt` are not validated. `pinned` on create or edit bypasses the cap. | `posts.ts:104,169,197,331-332` |
| FEED-V2 | Every edit writes a revision and marks the post "Edited", even with no change. | |
| FEED-V3 | The 90 s reel limit is enforced on the client only. `durationSeconds` and `posterFileId` are dropped. | `Reels.tsx:701`, `reels.ts:47-48` |
| FEED-V4 | Story `background` and page `accent` are free-form CSS, so `url()` beacons are possible. | `stories.ts:43`, `pages.ts:192,303` |
| FEED-M1 | Moderation: reels, reel comments and stories cannot be reported. No "approve" action. No page-owner queue. The removal message always says "post" and uses kind `feed.mention`. `act` is not transactional. | `moderation.ts:19`, `routes/feed.ts:415-423` |
| FEED-M2 | Stories past 24 h stay visible until they 404. Their files stay readable for up to 5 minutes. | |

### 7.3 Low

- Socket audience rooms come from the token's `role` claim (stale for up to 24 h after a role change).
- A bad cursor gives 500 instead of 400.
- "Recent" paging can repeat or skip posts after a follow.
- Bookmarks are ordered by publish time, not save time.
- Page slugs race to a 500, and all-digit slugs are treated as ids.
- `ILIKE` wildcards are not escaped.
- A reaction notification fires on every emoji switch.
- Deleted posts stay in the "new posts" pill.
- `deletePage` emits no event.
- The story cap can be exceeded in a race.
- An owner can change the page audience without a `canTargetAudience` check.

### 7.4 SRS coverage, UX and accessibility (Feed)

**SRS coverage:**
- **FR-FEED-2:**
  - `format:'rich'` is rendered as plain text.
  - There is no UI for comment media.
  - Hashtag links (`?tag=`) are ignored by the API.
- **FR-FEED-3:** no class-level audiences, and feed media files ignore the audience.
- **FR-FEED-4:** see FEED-F1. Edit history is stored but never shown.
- **FR-FEED-6:** "Top" is capped at a 150-post window.
- **FR-FEED-7:** fan-out is bypassed.
- **FR-FEED-8:** see FEED-M1.
- **FR-FEED-10:** no click-through tracking; daily impressions are attributed to publish day; follower growth ignores unfollows.
- **FR-FEED-11:** "share to chat as a card" is missing.
- **FR-FEED-12:** realtime is undermined by R1–R3 and B5–B9.
- **@mentions:** styled but not resolved or notified.
- **Reels and Stories:** not in the SRS at all (no requirements of record).

**UX and accessibility:**
- Reactions other than Like are reachable only by hover or long-press, not by keyboard.
- Menus use `role=menu` without `menuitem` roles or arrow-key navigation.
- Comment textareas are unlabelled.
- Poll buttons lack `aria-pressed`, and a single vote cannot be retracted.
- Poll, RSVP and comment controls are shown to users without FEED_COMMENT.
- The "new posts" pill has no `aria-live` and ignores the current filter.
- **On phones, Pages-directory cards and the type filter are clipped at the right edge** (`phone_app_feed_pages.png`). The automated overflow check missed it because a parent clips the content.

---

## 8. Meet module

### 8.1 Critical and high

| ID | Sev | Finding | Evidence | Status | Recommendation |
|---|---|---|---|---|---|
| MEET-SEC1 | **Critical** | **The lobby is not a gate.** The socket joins the room *before* the knock check. Knockers get the roster, 200 chat messages, polls, Q&A, captions and reactions. They can send chat, captions and votes. On mesh, admitted peers answer their offers and send camera and mic. | `realtime/meet/namespace.ts:235,255-287,1155-1167`, `state.ts:61-63`, `transport/mesh.ts:150-151` | 🔍 | Do not join the room until admitted. `context()` should search participants only. The mesh client should reject offers from people not on its roster. |
| MEET-SEC2 | **Critical** | **Any participant can crash the realtime gateway** (see X-03). | Live: gateway down after one `meet:question_upvote`. | ✅ Verified live | Wrap all handlers, validate with zod. |
| MEET-SEC3 | **Critical** (mesh) | **Removed, denied or knocking users can rejoin directly over the socket** (`rloadParticipant` ignores state). `POST /join` resets `state` on an existing row, so bans do not stick. | `rdb:113-123`, `ns:245-251`, `svc:434-441` | 🔍 | Admit only `active` rows. Keep `removed` as a ban, enforced in the API too. |
| MEET-SEC4 | **Critical** (privacy) | **DM calls and chat-scheduled meetings are open to the whole institution.** `category` is dropped by zod, so the policy defaults to `permission`. `/instant` disables the lobby. `announceLive` notifies every user (≤500) or nobody. | `MeetSchedulePopover.tsx:105,126-131`, `routes/meet.ts:509-516,277-287`, `svc:554-576` | 🔍 | Map category to admission policy. Default conversation calls to invited plus conversation members. |
| MEET-SEC5 | High | **Meeting REST routes do not check who is asking.** Details, AI artefacts, attendance (emails, MIS ids), recordings and ICS are all readable. Transcript and notes accept knocking or denied participants. | Live: for an **invite-only meeting**, an uninvited student got 200 on `GET /:id`, `/recordings` and `/ics`, and an uninvited staff member got 200 on `/ai`. `routes/meet.ts:526-548,1080,1156,1228-1349,1720-1773` | ✅ Verified live | A single `assertMeetingAccess` (host, invitee, conversation member, or attended as active). |
| MEET-SEC6 | High | **Guest tickets work outside their meeting.** There is no `meetingId` binding, no `jti` check and no expiry when the meeting ends (12 h lifetime). Guests can call `/ai/translate` and `/ice`. | `middleware/meetAuth.ts:47,90-121` | 🔍 | Bind ticket to meeting, validate `jti`, expire at meeting end. |
| MEET-SEC7 | High | **The API can be crashed from Meet routes:** invalid `limit`, guest join with an FK violation, invites to unknown users. | ✅ Live (`limit=x`). `svc:448-463`, `routes/meet.ts:1748` | ✅ Verified live | See X-02. |
| MEET-RT1 | High | **A dropped connection leaves the user stuck in the lobby screen.** On reconnect the row is `left`, so the client shows "waiting to be let in", but the user is not in the host's waiting list. Cloudflare token and track calls are refused, and attendance stops. | `useMeetRoom.ts:310-335`, `ns:1206-1229`, `routes/meet.ts:913-916` | 🔍 | Restore `active` on rejoin (or re-call `/join`). Add a "reconnecting" UI state. |
| MEET-RT2 | High | **Meetings are never closed automatically** when everyone leaves, the host abandons, or a scheduled meeting never happens. They stay in `/live` forever, wrap-up never runs, and attendance is inflated. | grep of worker and services | 🔍 | Worker sweep: idle for N minutes means end, then wrap-up. Expire no-shows. |
| MEET-RT4 | High | **Cloudflare SFU cannot recover from ICE failure.** `restartIce()` runs without renegotiation (no `onnegotiationneeded` or `/sfu/renegotiate`), so media stays dead until the user rejoins. | `transport/cloudflare.ts:195-197` | 🔍 | Implement renegotiation on ICE restart. Handle `disconnected`. |
| MEET-BUG1 | High | **Attendance is over-counted after a rejoin.** `joined_at` is kept while `left_at` is cleared, so time is counted twice. Example: 10 + 10 minutes is recorded as about 50. This attendance is used as lesson-delivery evidence. | `svc:437,523-524`, `rdb:246-247` | 🔍 | Store attendance segments (legs). Sum the legs. |
| MEET-BUG3 | High | **Recordings are lost** when the host ends the meeting, leaves, or navigates away (the recorder is discarded on unmount). The DB row stays `recording`, so later starts return 409. Late joiners' audio is not mixed in. The whole recording is buffered in RAM (~900 MB per hour). | `useMeetRecorder.ts:287-296,369-373` | 🔍 | Stop and upload before `endForAll`. Chunked upload. Reconcile the DB state. Ideally record on the SFU side. |
| MEET-BUG4 | High | **Breakouts do not work on the client.** `meet:breakout_assigned` and `meet:breakout_broadcast` are never handled. Chat and media are not separated. There is no auto-close timer (FR-MEET-16). | grep, `ns:481` | 🔍 | Build the client side, or hide the feature. |

### 8.2 Medium and low

- **MEET-SEC8:** socket `meet:settings`, `PATCH /:id` and `/instant` skip the `MEET_TRANSCRIBE`, `MEET_AI_USE` and `MEET_RECORD` checks. A student co-host can turn on transcription.
- **MEET-SEC9:** quiz polls leak `correct_option_index` to late joiners and after the first vote. The voter's `myVote` is broadcast, which breaks anonymous polls. Poll and question ids are not tied to the meeting. Votes are accepted after a poll closes, and options are not range-checked.
- **MEET-SEC10:** one shared 24 h TURN credential is handed to anonymous guests.
- **MEET-SEC11:** `conversationId` membership is not checked when creating a meeting, so reminder spam is possible. ICS injection is possible through `recurrence_rule` and `\r` in titles. `meet:note_share` author spoofing. No socket rate limits. `PATCH` can set `status` freely.
- **MEET-RT3:** room state is in memory, so a gateway restart loses lobby, recording, spotlight and breakouts and leaves ghost `active` rows. Multi-instance is not supported.
- **MEET-RT5:** no host handover. Admin takeover exists only in REST. A newly promoted co-host does not receive the current lobby.
- **MEET-RT6:** ending from REST never notifies the gateway (PreJoin "End" leaves people connected). The wrap-up job has no `jobId`, so it can run twice.
- **MEET-RT7:** the reminder audience and the live-announcement audience disagree. "Anyone signed in" meetings remind only the host. An early start still sends "starts soon".
- **MEET-BUG2:** no UNIQUE `(meeting_id, user_id)`, so duplicate participant rows are possible.
- **MEET-BUG5:** `meeting_events` partition expiry (see X-01).
- **MEET-BUG6:** the AI rolling summary runs only once, and every open client makes its own LLM call (users without MEET_AI_USE get 403).
- **MEET-BUG7:** room state is not reset between calls.
- **MEET-BUG8:** a transient `connect_error` replaces the room with "Something went wrong — reload", and reloading loses the call.
- **MEET-BUG9:** a refused third screen share keeps publishing.
- **MEET-BUG10:** quick-schedule "Private" sends `invited` with no invitees, so nobody can join.
- **MEET-BUG11:** knockers who leave stay in the host's lobby list.
- **MEET-BUG12:** settings with no effect: `webinarMode`, `autoRecord`, `maxVideoQuality`, `allowRename`, `aiAutoSummary`. `MEET_SCREENSHARE` is never enforced.
- **Resources:** a screen stream leaks if `startScreenShare` throws. The camera stays on in the lobby with no timeout. Abandoned guest pre-joins leave `knocking` rows.

### 8.3 UX, responsiveness and accessibility (Meet)

- **No in-call device switching** for camera, mic or speaker. An unplugged device is not handled. There is no audio-only fallback when the camera fails.
- **Grid:** no paging, so 100 participants means tiny tiles. Up to 25 videos are decoded on a phone. When someone presents, the fixed `w-44` filmstrip squeezes the stage to about 170 px on a 360 px phone.
- **Accessibility:** tiles have no accessible names. Mute and connection state are shown only as icons. Captions and lobby knocks have no `aria-live`.
- **"Join muted"** is ignored: PreJoin always starts with the mic on. There is no background blur (FR-MEET-4) and no virtual backgrounds or noise suppression (FR-MEET-18).
- **Captions** use the browser's `SpeechRecognition`: Chromium only, audio sent to Google rather than the self-hosted Whisper the SRS specifies, and speech is only transcribed for people who switched captions on (FR-MEET-17).
- **Calls are not announced:** no ringing, and the header call buttons do nothing (FR-NOTIF-6).

### 8.4 SRS coverage (Meet)

| Requirement | Status |
|---|---|
| FR-MEET-6, 8, 11, 20 | OK |
| FR-MEET-1, 2 (RRULE never expanded; no invite email or ICS sent), 3, 4, 5, 7, 9, 10 (meeting chat never reaches the conversation), 12, 13, 15, 17, 19 (no auto-admit when the host arrives) | **Partial** |
| FR-MEET-14 | **At risk** (partition expiry) |
| FR-MEET-16 | **Not working** (breakouts) |
| FR-MEET-18 | **Missing** |

> `docs/MEET_IMPLEMENTATION_PLAN.md §8` claims that every FR-MEET is implemented. The code does not support that claim.

---

## 9. Notifications

| ID | Sev | Finding | Evidence | Status | Recommendation |
|---|---|---|---|---|---|
| NOTIF-01 | High | **There is no notification centre, and the bell is fake.** `<IconButton label="Notifications">` has no `onClick` and a *permanent* red dot ("Placeholder dot until the Phase 5 notification centre"). The web app never calls `/api/notifications`. | `apps/web/src/pages/AppShell.tsx:322-326`. Live: clicking does nothing (`notification-centre.png`). | ✅ Verified live | Build the panel: list, unread count, group by kind, mark read and read-all, deep links. Drive the dot from the real count. |
| NOTIF-02 | High | **Meet and Feed notifications are never shown.** `ChatNotificationBridge` handles only chat kinds, `MailLayout` only refreshes the inbox, and nothing handles `meet.live`, `meet.invited` or `feed.*`. | grep. The rows are written and pushed: `routes/meet.ts:1834`, `feed.ts:279,336,416,554`. | 🔍 (live: `notification:new` with kind `feed.published` reached the socket) | One generic bridge for all kinds, with per-kind sound and OS notification policy. |
| NOTIF-03 | High | **No Web Push, email fallback or digest.** `sw.js` has no `push` or `notificationclick` handler (0 matches). There is no VAPID key or subscription table, and `user_devices` is unused. OS notifications appear only from an open, hidden tab. | `apps/web/public/sw.js`, `NotificationContext.tsx:140-160` | ✅ Verified (grep) | VAPID push, subscription storage, notification click → deep link. Email digest for unseen mentions and DMs (FR-NOTIF-2/3/4). |
| NOTIF-04 | High | **Deep links land on the Feed.** There are no routes for `/app/chat/:conv`, `/app/chat/:conv/:msg`, `/app/chat/invite/:code` or `/app/mail/campaigns/:id`; the catch-all redirects to `/` and then `/app/feed`. Sign-in discards the return path (outside the mentorship worktree fix). | `App.tsx:107,141,163`; links in `packages/chat/src/notifications.ts:94,148,218`, `MessageThread.tsx:620`, `ChannelSettings.tsx:237` | 🔍 | Add the routes (or use the `?c=&m=` form). Keep `returnTo` through SSO. |
| NOTIF-05 | Medium | **No unread badges across modules.** `RailLink`/`TabLink` accept `badge`, but nothing passes it. Only Chat has a tab-title count. | ✅ Live (MAIL-H10). `AppShell.tsx:98,103,160` | ✅ | Unified unread store (chat, mail, feed, meet) feeding the rail, tab bar and PWA app badge (`navigator.setAppBadge`). |
| NOTIF-06 | Medium | **Data-model issues.** The upsert keeps `read_at`, so repeat events stay "read". `RETURNING` re-pushes every refresh (re-plays sounds). Inserts run in a loop (500 sequential INSERTs). No retention or pruning. Reading a conversation does not clear its notifications. DND/quiet hours are enforced only on the client. | `packages/notify/src/index.ts:94-104,188-196` | 🔍 | Per-event keys or reset `read_at`. Batch inserts. Retention job. Server-side DND. |

---

## 10. Platform: realtime, files, auth/RBAC, admin, search, ops

### 10.1 Realtime gateway

| ID | Sev | Finding | Evidence |
|---|---|---|---|
| RT-01 | Critical | Crashes on unhandled async errors (X-03). | ✅ live |
| RT-02 | Medium | **A Redis outage at boot permanently disables delivery.** `connectRedis()` runs once, so the notify, chat and logout subscribers are never attached. The notify publisher has `enableOfflineQueue:false`, so the first publishes after an API restart are dropped. | `realtime/index.ts:74-143,472`, `notify/index.ts:188-196` |
| RT-03 | Medium | **Duplicate delivery with N>1 instances** (`io.to` on every instance, on top of the Redis adapter). Use `io.local`, as the logout path already does. | `index.ts:81-112` |
| RT-04 | Medium | **The JWT is checked only at handshake.** Expired tokens stay connected. The 60 s sweep checks `users.status` but not `session_revocations`. The client never handles `connect_error` or `io server disconnect` outside Meet. `ConnectionBanner` only reflects `navigator.onLine`, and the `reconnecting` state is never set. | `index.ts:223-253`, `lib/socket.ts`, `ConnectionBanner.tsx:17-34` |
| RT-05 | Medium | **No production guard on the default JWT secret in realtime** (the API and files service have one). | `realtime/src/config.ts:8` |
| RT-06 | Medium | `presence:query` takes any 500 ids with no permission or contact check. PRESENCE_VIEW is never enforced. | `index.ts:405-409` |

### 10.2 Files service

| ID | Sev | Finding | Evidence |
|---|---|---|---|
| FILE-01 | High | **Ignores suspension, single sign-out and FILE_UPLOAD/FILE_DOWNLOAD.** `requireSession` only verifies the JWT signature, so a revoked or suspended token keeps working for up to 24 h. | `apps/files/src/index.ts:21-30,76-93` |
| FILE-02 | High | **Upload size and quota are not enforced.** Only the declared size is checked. `PUT /content` streams with no byte cap. nginx allows 5 GB. There are no quotas, no rate limit, and no garbage collection of pending or orphaned files. One user can fill the shared EC2 disk. | `index.ts:105,155`, `storage/driver.ts:80`, `infra/nginx/tupo.conf:25` |
| FILE-03 | Medium | The feed branch of `canReadFile` ignores audience and lifecycle (staff-only post media, expired stories and draft comments are readable). | `access.ts:139-163` |
| FILE-04 | Medium | Access-control v2 is not applied in files or realtime (legacy `role_permissions`), so in `enforce` mode they disagree with the API. | `files/src/access.ts:178-190`, `realtime/src/access.ts:43-52` |
| FILE-05 | Low | `bytes=-N` range is parsed incorrectly. Upload ticket expiry is not enforced. The S3 driver is unimplemented. **No virus scan** (FR-FILE-4). No server-side MIME sniffing (FR-FILE-8). | `index.ts:290-293`, `driver.ts:106-108` |
| FILE-06 | High (feature) | **The Files module UI is "Coming Soon"** (`App.tsx:120`), yet it is a primary tab on mobile and desktop. That leads users into a dead end. | ✅ live (`phone_app_files.png`) |

### 10.3 Auth, SSO, RBAC and admin

| ID | Sev | Finding | Evidence |
|---|---|---|---|
| AUTH-01 | High | **The session model departs from the SRS.** A 24 h bearer JWT in `localStorage`, no refresh or rotation, no server-side logout (logout just clears storage), no device list. A hard expiry redirects mid-task without warning (FR-AUTH-3/4, SEC-A3/A4). | `config.ts:17`, `AuthContext.tsx:91-102`, `api.ts:42-50` |
| AUTH-02 | Medium | **Privilege escalation through role assignment.** `PUT /api/users/:id/role` and `/status` have no hierarchy check, so any holder of USERS_MANAGE can make themselves Admin or suspend admins. Suspension does not revoke sessions. | `routes/users.ts:81-176` |
| AUTH-03 | Medium | Dead permissions: PRESENCE_VIEW and NOTIFICATIONS_MANAGE are never enforced. FILE_UPLOAD and FILE_DOWNLOAD are not enforced by the files service. | `access/manifest.ts:79,101` |
| ADM-01 | Medium | **The audit log is neither immutable nor scalable.** No append-only trigger or hash chain. No index on `created_at`. No filters, pagination or export (SEC-C6, FR-ADM-4). | `0001_init.sql:124-136`, `routes/audit.ts:12-20` |
| ADM-02 | Medium | **No security headers on the SPA:** no CSP, HSTS, X-Frame-Options or Permissions-Policy, so the app can be framed (clickjacking). | `infra/nginx/tupo.conf:63-69` |
| ADM-03 | Low | Missing admin features: no retention policies (FR-ADM-3), compliance export (FR-ADM-6), feature flags (FR-ADM-10), webhooks or API keys (FR-INT-1..3, FR-AUTH-8). | |
| ADM-04 | Low | The admin Users table has **48 unlabelled inputs** (per-row controls without labels). | ✅ live sweep |

### 10.4 Search

- `ILIKE '%q%'` is used across users, mail, files and meetings with no trigram indexes. It will not scale.
- No `from:`/`in:`/`has:` operators, no typo tolerance, and no file-content search (FR-SRCH-2/4/6).
- `%` and `_` are not escaped in user search.

### 10.5 Internationalisation

- **None.** The UI is English only, with no locale framework and no language switch.
- The SRS requires **English, Kinyarwanda and French** with a per-user choice (§13.4, FR-USR-8).

### 10.6 Ops, CI and testing

| ID | Sev | Finding |
|---|---|---|
| OPS-01 | High | **CI deploys to production on every push with no quality gate:** no lint, typecheck, unit tests, verify scripts, `npm audit` or secret scan (§14.4, SEC-P8/P9). |
| OPS-02 | High | **No backup automation** for Postgres or `/var/lib/tupo/storage` anywhere in the repo (SEC-D5, §14.5). |
| OPS-03 | Medium | pm2 runs one fork-mode instance per service, so `pm2 reload` is really a restart (downtime on every deploy). Combined with X-02 and X-03, any crash is a full outage. |
| OPS-04 | Medium | No structured logs, metrics, tracing or error tracking (Sentry) (§13.5). `/svc/*/health` is public and echoes raw DB errors. |
| OPS-05 | Medium | Typecheck depends on stale `dist/` folders (see §2.1). `@tupo/feed` has no tests, so `npm test` exits non-zero. One feed unit test is order-dependent. |
| OPS-06 | Medium | **Test coverage holes:** no unit tests for notifications/notify, the files service (`canReadFile`!), search, users/roles routes, realtime chat/feed/presence handlers, worker jobs, the chat service, the feed package, or web components. |
| OPS-07 | Low | `verify:meet:history`, `verify:meet:prejoin`, `verify:feed:ui` and parts of `verify:chat:ui` are broken by harness rot (missing `verify-mis` stub and install-modal dismissal). |
| OPS-08 | Low | Google Fonts loaded from a third party (privacy, and breaks offline). `.feed-ui-shots` is not excluded from the deploy rsync. |

---

## 11. Responsiveness and accessibility sweep

The sweep loaded 13 pages × 3 viewports as an Admin user. Full data is in `gap-analysis-2026-10-12/sweep.json`.

| Page | Horizontal overflow (360 / 768 / 1440) | Unlabelled inputs | Targets < 24 px | `<h1>` | Notes |
|---|---|---|---|---|---|
| /app/chat | 0 / 0 / 0 | 0 | 0 | **none** | Good mobile layout (`phone_app_chat.png`) |
| /app/feed | 0 / 0 / 0 | 0 | 8–9 | **none** | |
| /app/feed/pages | 0 / 0 / 0 | 2 | **28** | 1 | **Cards and filter visually clipped on phone** (overflow hidden by a parent) |
| /app/mail | 0 / 0 / 0 | 1 | 0–6 | **none** | |
| /app/mail/settings | 0 / 0 / 0 | 1 | 1 | 1 | |
| /app/meet | 0 / 0 / 0 | 1 | 6 | 1 | |
| /app/meet/history | 0 / 0 / 0 | 0 | 1 | 1 | |
| /app/files | 0 / 0 / 0 | 0 | 0 | **none** | "Coming soon" placeholder |
| /app/admin/dashboard | 0 / 0 / 0 | 3 | 0 | 1 | |
| /app/admin/users | 0 / 0 / 0 | **48** | 0 | 1 | |
| /app/admin/audit | 0 / 0 / 0 | 0 | 0 | 1 | |
| /app/admin/oversight | 0 / 0 / 0 | 1 | 6 | 1 | |
| /app/admin/roles | 0 / 0 / 0 | 0 | 12 | 1 | |

**What the sweep shows:**
- **No page scrolls horizontally** at any viewport. This is good, and a result of PR #32.
- Chat, Feed, Mail and Files have **no `<h1>`**, so screen-reader users have no page landmark heading.
- **Small touch targets** (under 24 px; WCAG 2.2 AA 2.5.8) are concentrated in the Feed pages directory (28), Roles (12) and Feed (8).
- There are **unlabelled form controls**, worst in Admin › Users (48).
- `<html lang>` is set, and icon buttons have accessible names (0 unnamed buttons found). Both are good.
- Gaps listed under the modules above:
  - no keyboard path to feed reactions;
  - mail rows are not focusable;
  - no focus trap in the mail composer or the mobile dock;
  - no `aria-live` for captions, lobby knocks or the feed "new posts" pill;
  - meeting tiles have no accessible names.

---

## 12. Remediation roadmap

### Phase 0: this week (blockers and actively exploitable issues)

1. **X-01, partitions:** check prod and create Nov 2026–Jan 2027 partitions *before 1 Nov*. Then add the maintenance cron, a DEFAULT partition and an alert.
2. **X-02, X-03, X-04, crash-proofing:**
   - async error wrapper on every Express route, plus `express-async-errors`;
   - socket handler `safe()` wrapper;
   - zod validation of numeric and query params;
   - `unhandledRejection` logging.
3. **MAIL-C1, SQL injection:** allow-list `folder` and use bind parameters. Grep all packages for other `${…}` inside SQL strings.
4. **MAIL-C2 and X-07, XSS:** server-side `sanitize-html` on mail, templates, campaigns and signatures; DOMPurify on render; a CSP header on the SPA.
5. **MAIL-C3 and MAIL-H1:** drafts and scheduled mail must not create visible recipient rows.
6. **FEED-S2 and FEED-A1:** filter `notifyFollowersOfPost` by audience, and add `loadVisiblePost` to every engagement route.
7. **CHAT-C1 and CHAT-C2:** allow-list message types; scope edit history (and polls and reactors) by conversation.
8. **MEET-SEC5:** `assertMeetingAccess` on every meeting read route.

### Phase 1: next 2–3 weeks (security hardening and realtime correctness)

- **Rate limiting** across REST and sockets (X-05).
- **Neutral broadcast payloads** for Chat, Feed and Meet (X-06).
- **Socket evictions:** removed members (CHAT-H2) and the meet lobby gate (MEET-SEC1, SEC3).
- **Meet privacy:** DM and conversation call admission (MEET-SEC4); guest ticket binding (MEET-SEC6).
- **Files service:** auth parity (FILE-01), byte caps and quotas (FILE-02).
- **Mail access and delivery:** per-message visibility (MAIL-H2), list member gating (MAIL-H7), SMTP claim and bounce fixes (MAIL-H4, H5), merge escaping (MAIL-H8).
- **Announcement guard** (CHAT-H1). **Role-hierarchy check** (AUTH-02).
- **CI quality gate:** typecheck, unit tests and verify scripts before deploy (OPS-01). **Backups** (OPS-02).

### Phase 2: next 4–6 weeks (missing features users notice)

- **Notification centre**, a **generic notification bridge**, **unread badges** for every module, **deep-link routes** (NOTIF-01, 02, 04, 05).
- **Web Push** (VAPID) and an email digest (NOTIF-03).
- **Typing fix**, reconnect catch-up, a live thread panel, read receipts in the UI (CHAT-H3, H4, H6, H7).
- **Feed:** drafts and scheduled management (FEED-F1); scheduled-publish fan-out (FEED-B3); live permalink (FEED-L1).
- **Meet:** reconnect state (MEET-RT1); auto-close (MEET-RT2); attendance legs (MEET-BUG1); safe recording (MEET-BUG3); Cloudflare ICE restart (MEET-RT4).
- **Block/report** users (CHAT-H11).
- **Files module UI**, or remove the tab until it exists.

### Phase 3: quarter (SRS completeness and scale)

- i18n (EN/RW/FR).
- Meet: breakouts; background blur and virtual backgrounds; self-hosted captions (Whisper).
- Feed: class-level audiences, share-to-chat card, @mention resolution.
- Search: Postgres FTS plus trigram, and operators.
- Mail: inbound mail (FR-MAIL-11), async bounces, List-Unsubscribe.
- Session model: httpOnly refresh cookie.
- Audit-log immutability, retention policies, compliance export.
- Multi-instance realtime: `io.local`, room state in Redis.
- Performance: missing indexes (`messages(conversation_id,id)`, `feed_timeline(post_id)`, `audit_logs(created_at)`), feed ranking queries, mail pagination.
- Accessibility pass: headings, labels, focus traps, keyboard access to reactions and menus, `aria-live` regions, 24 px targets.

---

## 13. Appendix

### A. Reproducing the live probes

```bash
cd nga-communication-module
npm run dev                                   # api 5190, realtime 5191, files 5192, web 5194
OUT=/tmp/probe.json node scripts/gap-realtime-probe.mjs
OUT=/tmp/ui        node scripts/gap-ui-probe.mjs        # screenshots + sweep.json
SKIP_API_CRASH=1   node scripts/gap-security-probe.mjs  # omit SKIP_API_CRASH to also crash-test the API
```

> ⚠️ `gap-security-probe.mjs` **deliberately crashes** the local API and realtime processes, which proves X-02 and X-03. Never point it at production. Restart `npm run dev` afterwards.

The probes mint JWTs with the local `JWT_SECRET`, stub `/api/sso/verify-mis`, and suppress the PWA install modal (see the Tupo UI audit recipe). They clean up their users with `scripts/lib/purge.mjs`. Once the corresponding fixes land, the failing checks double as regression tests. Consider promoting them to `verify:security` and `verify:realtime`.

### B. Evidence files (`docs/gap-analysis-2026-10-12/`)

| File | Shows |
|---|---|
| `mail-xss.png` | XSS image rendered (broken `<img>`), inbox badge "6" for 3 threads, duplicated recipient "Ben Probe, Ben Probe" |
| `nav-after-mail.png` | No Mail unread badge in the rail after new mail |
| `notification-centre.png` | Bell click: no panel opens, permanent red dot |
| `phone_app_feed_pages.png` | Clipped cards on phone; leftover test pages |
| `phone_app_chat.png` | Chat mobile layout (good) |
| `chat-typing.png`, `chat-offline.png` | Typing indicator and offline banner working |
| `realtime-probe-results.json`, `results.json`, `sweep.json` | Raw pass/fail output of the probes and the sweep |

### C. Verified-live failing checks (raw)

```
❌ typing auto-expires server-side when stop never sent (9s)              — no expiry event
❌ arbitrary non-emoji reaction string rejected                           — status 200
❌ mail read on device 1 syncs to device 2 live                           — no events
❌ folder param is not injectable                                         — status 200, 1 foreign thread returned to a student
❌ a draft does NOT appear in the recipient inbox                         — leak=true
❌ student (no MAIL_SEND) cannot place a subject in staff inbox via draft — draft status 201
❌ scheduled mail is NOT visible before its send time                     — visible
❌ student cannot export distribution-list member addresses               — status 200
❌ student does NOT receive staff-only post body over socket              — LEAK: feed:post_new delivered
❌ student does NOT get notification for staff-only post                  — kind feed.published
❌ student cannot comment on / list comments of / react to staff-only post — 201 / 200 / 200
❌ broadcast does not overwrite viewer's "mine"                           — mine = "like"
❌ comment broadcast does not carry author canEdit=true                   — "canEdit":true
❌ repeated views by one user are deduplicated                            — viewCount=3
❌ 60 messages in a burst are throttled                                   — {"201":60}
❌ 40 feed comments in a burst are throttled                              — {"201":40}
❌ nav shows an unread mail badge                                         — "Mail"
❌ mail HTML with onerror payload does NOT execute                        — executed=true
❌ feed comment appears live on the permalink                             — not shown
❌ client cannot post a message with type "system"                        — stored type=system
❌ group owner can remove a spoofed system notice                         — 400 "System messages cannot be deleted."
❌ edit history of a foreign DM message is NOT readable (IDOR)            — "PRIVATE ORIGINAL" returned
❌ student cannot post into announcement channel via thread reply         — status 201
❌ removed member stops receiving the group over an open socket           — leaked=true
❌ uninvited student cannot read meeting / recordings / ICS               — 200 / 200 / 200
❌ uninvited staff cannot read the meeting AI artifacts                   — 200
❌ GET /api/meet?limit=x does not crash the API                           — API process exited
❌ bogus meet:question_upvote does not crash the realtime gateway         — gateway exited (FK violation)
❌ INSERT into messages dated 2026-11-01                                  — no partition of relation "messages" found for row
```
