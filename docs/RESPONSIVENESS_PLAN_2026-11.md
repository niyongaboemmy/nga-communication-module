# Tupo: Plan to Make It Feel Like WhatsApp, Messenger and Slack

| | |
|---|---|
| **Date** | 3 November 2026 |
| **Status** | Draft for team review |
| **Inputs** | [`GAP_ANALYSIS_2026-10-12.md`](GAP_ANALYSIS_2026-10-12.md), the evidence in [`gap-analysis-2026-10-12/`](gap-analysis-2026-10-12/), [`REMEDIATION_DELIVERY_PLAN.md`](REMEDIATION_DELIVERY_PLAN.md), and the code on `feat/gap-remediation` @ `a11fb16` |
| **Audience** | Tupo developers, QA and the release owner |
| **Constraint** | No paid infrastructure. Everything runs on the existing shared EC2 box (2 vCPU, 4 GB RAM, also hosting MIS, Task Mentor and Tendo), Postgres 18 and Redis |

> The gap analysis answers *"what is broken?"*. The remediation plan answers *"how do we fix it?"*, and most of it is now done. This plan answers the next question: **what does it take for Tupo to feel as fast, reliable and complete as the messaging apps students and staff already use every day?** It does not repeat findings. Where an item closes a finding, the finding ID is given.

---

## 1. Where we stand today

### 1.1 Remediation progress

On `feat/gap-remediation` (59 commits, last one 13 Oct):

| Phase | Status |
|---|---|
| Phase 0 (stabilise): partitions, crash-proofing, SQLi, XSS, drafts, feed audiences, chat integrity, meet access, CI gate, backups | ✅ Done on the branch |
| Phase 1 (correctness): validation, rate limits, files auth and quotas, neutral broadcasts, room lifecycle, unread model, block/report, mail delivery, attendance legs, meeting auto-close | ✅ Done on the branch |
| Phase 2 shell and admin (F-01 to F-14): notification centre, push and digest, badges, URL navigation, error boundaries, PWA, presence and status, admin screens | ✅ Done on the branch |
| Phase 2 chat (B-07 to B-13), mail (C-08 to C-13), feed (D-05 to D-11) | ✅ Done on the branch |
| Phase 2 mail **C-14, C-15** (campaign screens, Sent paging, external attachments, headers) | ⬜ Not started |
| Phase 2 meet **E-05 to E-11** (devices, host experience, SFU recovery, scheduling, recordings, breakouts, polish) | ⬜ Not started |
| Phase 3 (i18n, files UI, session model, search, meet AV, scale, accessibility) | ⬜ Not started |

### 1.2 The urgent problem: none of this is in production

The branch has **never been merged or deployed**. `main` (and so production) still runs the code the gap analysis tested, with every Critical finding open. In particular:

- **X-01 (partitions).** `main` has no partition maintenance. Production was migrated on 21 Aug with partitions up to `2026_10`. Unless someone created partitions by hand, **every chat message and meeting event insert has failed since 1 Nov 2026.** This has to be checked before anything else (step S-01 below).
- Every exploitable issue (mail SQL injection, stored XSS, staff-only feed posts reaching students, the edit-history IDOR, uninvited meeting access, one-request API crash) is still live.

`main` also moved on in parallel (PRs #35 to #37: active users only, My AI, external AI, and a mail draft hotfix `58141e2`). Merging needs care:

- **Migration numbers collide.** `main` has `0030_subject_channels.sql` and `0031_user_mis_status.sql`. The branch has `0031_partition_maintenance.sql` through `0042_feed_timeline_post_index.sql`. The runner orders by file name, so the branch migrations must be renumbered after `main`'s (from `0032` upward) **before** merging, and checked against what `tupo_prod` has already recorded.
- `58141e2` ("Mail: never list a draft to its recipients") on `main` overlaps C-03 and C-08 on the branch. Keep the branch's version, since it is the complete fix, and keep `main`'s regression test.

### 1.3 How far Tupo is from the big apps

Measured or traced in the code on the branch:

| What users feel | Tupo today | WhatsApp / Messenger / Slack |
|---|---|---|
| Opening the app | Downloads one **1.6 MB JavaScript bundle** (local build, 10 Oct; no route splitting, `lazy()` is used nowhere), then fetches everything from the network. No data is cached on the device. | The last state shows **instantly** from on-device storage, then updates quietly. |
| Opening a conversation | Spinner, then `GET messages?limit=40` | Messages already on the device. The network only fills the gap. |
| Conversation list | One query returns **every** conversation the user is in, with no limit | Paged, kept on the device, updated by small changes (deltas) |
| Sending | Optimistic, with an outbox (good) | The same, plus clear sent, delivered and read ticks for every message |
| After being offline for a while | Catch-up for the **open** conversation only, up to 100 messages | One sync call brings every conversation up to date |
| Closed app | Web push exists (F-04), but only on the branch | Push in seconds, reply from the notification, an app-icon badge |
| Deploys | pm2 runs one fork-mode process per service. Every deploy and every crash is a full outage and drops every socket. | Rolling deploys, so nobody notices |
| When something breaks | Probes run by hand. No metrics, error tracking or alerts. | On-call staff know before users do |

The rest of this plan closes that gap in the right order.

---

## 2. What "responds like the big apps" means: targets

These are the targets for release reviews. Each one is measured, not estimated (see §9).

| # | Target | How it is measured |
|---|---|---|
| T1 | **Warm start:** the app is usable from on-device data in **under 500 ms** on a mid-range Android phone | Lighthouse and Playwright trace, with a throttled CPU (4×) |
| T2 | **Cold start:** first screen usable in **under 2.5 s** on fast 3G | Lighthouse CI on every PR |
| T3 | **Initial JS** under **250 KB gzip** for the shell plus the landing module | Bundle-size budget in CI |
| T4 | **Message delivery:** sender's send to recipient's screen is under **300 ms at p95** with both online | `verify:latency` probe (two sockets, 200 messages) |
| T5 | **Opening a conversation already on the device** shows messages in **under 100 ms** | Playwright timing |
| T6 | **Zero lost messages:** every message accepted by the client appears for every member, exactly once and in order, after any mix of offline, reload, reconnect or server restart | `verify:sync` chaos probe |
| T7 | **Push:** a closed-tab recipient gets the OS notification within **5 s at p95** | Push probe using a test subscription |
| T8 | **Availability:** a deploy drops no message and shows no error. Clients reconnect within 5 s. | Probe sending through a `pm2 reload` |
| T9 | **Interaction:** every tap gives visual feedback in under **100 ms**, with no layout shift as content loads (CLS < 0.1) | Lighthouse, manual review on phones |
| T10 | **Capacity:** **1,500 concurrent sockets** and **50 messages/s** on the current box, with API p95 under 200 ms | k6 load test (§8) |

---

## 3. The eight patterns the big apps share

Every work item in §5 applies one of these. They are the design rules for new code too.

1. **Local first.** The device keeps a copy of what the user has seen (conversations, recent messages, mail list, first feed page, profile). Screens render from it straight away, and the network brings it up to date. The user never stares at a spinner for data they have already seen.
2. **Optimistic everything.** Every action the user takes (send, react, read, star, archive, like, vote, follow) changes the screen at once and is confirmed or rolled back later. Each action carries a client id so retries are safe.
3. **One ordered stream per user, with a cursor.** The server gives every change a sequence number. A client that reconnects says "I have everything up to N" and gets exactly what it missed, or "too far behind, reset". No guessing, no full reloads.
4. **Small events, then fetch if needed.** Socket events carry shared facts and ids, never one viewer's personal state (the X-06 lesson). A client that is unsure fetches.
5. **Delivery is visible.** Sending, sent, delivered and read are distinct states the user can see. Failure is never silent, and every failed item has a retry.
6. **Notifications reach people wherever they are.** Open tab: in-app. Hidden tab: OS notification. Closed: push. Ignored: email digest. Always deduplicated, and always respecting mute and do-not-disturb on the **server**.
7. **The UI never blocks.** Heavy work (media processing, search indexing, fan-out to followers) happens in the worker. Lists are paged and windowed. Images have thumbnails and placeholders so nothing jumps.
8. **Nobody notices a deploy or a crash.** More than one process, graceful hand-over, health checks, alerts, and a rollback that takes one command.

---

## 4. Step zero: ship what we already built (this week)

Nothing else matters until production is safe. These steps come before any new work.

| ID | Task | Acceptance | Est. (dev-days) |
|---|---|---|---|
| **S-01** | **Check production partitions now** (read-only): `SELECT relname FROM pg_class WHERE relname ~ '^(messages\|meeting_events)_(20\|default)' ORDER BY 1;` on `tupo_prod`, plus `SELECT max(created_at) FROM messages;`. If `2026_11` is missing, **create Nov 2026 to Feb 2027 partitions and a DEFAULT partition by hand at once** (the SQL is in `0031_partition_maintenance.sql` on the branch), then tell users chat is back. | Partitions exist through Feb 2027; a test message sends in production | 0.5 |
| **S-02** | Rebase `feat/gap-remediation` onto `main`. Renumber the branch migrations after `main`'s (`0032` upward). Resolve the overlap with `58141e2`. Check the migration runner's record table in `tupo_prod` so nothing runs twice or out of order. | CI green; `db:migrate` on a copy of `tupo_prod` (restored from the nightly dump) runs cleanly | 1.5 |
| **S-03** | Full regression on the rebased branch: unit tests, every `verify:*` suite, the `gap-*` and `gap2-*` probes (never `gap-security-probe` against production). | All green, apart from the known 1–3 flaky API tests, which pass on retry | 1 |
| **S-04** | Production prerequisites: backup installed (`docs/OPERATIONS_BACKUP.md`) and one restore drill; VAPID keys in the api and worker env files; `pg_dump -Fc tupo_prod` immediately before migrating. | Backup and restore proven; keys present | 0.5 |
| **S-05** | Deploy off-peak: migrations, then api and worker, then realtime, then files, then web. Then run `scripts/mail-sanitize-backfill.mjs --apply` after a reviewed dry run. Keep the CSP in report-only mode for 3 days, then enforce. | `npm run health` green; the probes' Critical checks green against production read-only paths; staff release note sent | 1 |
| **S-06** | Upgrade `nodemailer` (deferred in remediation §15, now safe to adopt) and raise the CI audit gate to `--audit-level=high`. | `npm audit` clean at high | 0.5 |

**Step zero total:** about 5 dev-days. **S-01 is today.**

---

## 5. Work plan

Six workstreams. The IDs (`R-`, `P-`, `S-`, `N-`, `U-`, `Q-`) are new to this plan. Estimates are in developer-days and include tests.

### 5.1 Workstream R: reliability (pattern 8)

The big apps feel solid mostly because they are never down. Today one crash or one deploy drops every user.

| ID | Task | Detail | Est. |
|---|---|---|---|
| **R-01** | Zero-downtime API | Run `tupo-api` as **2 pm2 cluster instances** (it is stateless). `pm2 reload` then replaces them one at a time. Add a `SIGINT` handler that stops accepting connections and finishes in-flight requests (`server.close()` with a 10 s limit), and `wait_ready`/`listen_timeout` in `ecosystem.config.cjs`. Memory cost about 150 MB, which the box has. | 1.5 |
| **R-02** | Graceful realtime restart | Socket.IO can't share sockets across instances without sticky sessions, so keep **one** realtime process but make restarts painless. On `SIGINT`, emit `server:restarting` to every client, then close. The client waits a random 0–3 s before reconnecting so 1,500 sockets don't stampede, and runs the sync in §5.3 on reconnect. Remediation already removed the in-memory meet state that a restart would lose (MEET-RT3 is still open; see U-30). | 2 |
| **R-03** | Partition and retention guard | Already on the branch (A-01). Add an **alert** when fewer than 2 months are ahead, and a weekly check that the DEFAULT partitions are empty (if not, move the rows). | 0.5 |
| **R-04** | Monitoring without paid tools | `pino` JSON logs for every service, rotated by `pm2-logrotate`. A `/metrics` endpoint per service (request rate, p95 latency, errors, connected sockets, queue depth, event loop lag) scraped by a small worker job into Postgres for 14 days. An admin **System health** page (extend F-14's system status) with charts. Alerts by email (the existing SMTP) and Telegram (the MIS reminder hub's bot) when the error rate, p95, queue depth, disk or partitions cross a threshold. | 4 |
| **R-05** | Error tracking | Capture unhandled errors from the browser (`window.onerror`, `unhandledrejection`, React error boundaries) and from the services into one `client_errors`/`server_errors` table, grouped by fingerprint, with release version and route. Shown on the System health page. (Self-hosted Sentry needs more RAM than the box has, so this is a small table, not a product.) | 2 |
| **R-06** | Rollback in one command | The deploy keeps the previous release directory and a `scripts/rollback.sh` that switches back and reloads. Migrations must stay backward-compatible for one release (expand, then contract) so the previous code still runs on the new schema. | 1 |
| **R-07** | Redis resilience | Remediation fixed boot-time outages (RT-02). Add a periodic `PING` health check with an alert, and a Redis `maxmemory` with `noeviction` for db 1 (BullMQ) and `allkeys-lru` for db 0, so presence and typing keys cannot fill the box. | 0.5 |

**Workstream R total:** about 11.5 dev-days.

### 5.2 Workstream P: perceived performance (patterns 1, 2, 7)

This is the biggest single reason Tupo feels slower than WhatsApp: it starts from nothing on every open.

| ID | Task | Detail | Est. |
|---|---|---|---|
| **P-01** | Split the bundle | `React.lazy` for every module (Chat, Mail, Feed, Meet, Admin, Settings) and for heavy pieces inside them: TipTap (mail composer), the emoji picker, meet transports, chart code, PDF and media viewers. Preload the next likely module on idle and on hover over the rail. **Target T3: under 250 KB gzip for the first screen.** Add a CI budget that fails the build when a chunk grows past its limit. | 3 |
| **P-02** | Local store | One IndexedDB store per **account** (keyed by user id, so a shared device never mixes users; this also closes the remainder of CHAT-M12), wrapped in a small typed module. Stores: conversations, the last 200 messages per recently opened conversation, members and profiles seen, mailbox first pages per folder, the first feed page, notifications, unread counts and the sync cursor (§5.3). Cleared on sign-out and on `server:reset`. Caps its size (about 50 MB) and evicts the least-recently opened conversations. | 5 |
| **P-03** | Render from the store first | Chat, Mail, Feed and the notification centre read from the store and render at once, then apply what the network returns (stale-while-revalidate). Show "Updating…" only when the network takes longer than 1 s. **Targets T1 and T5.** | 4 |
| **P-04** | Optimistic actions everywhere | Chat send already is. Extend the same pattern (client id, immediate UI, confirm or roll back with a toast) to reactions, read and unread, pin, star, archive, mute; mail star, read, move, label; feed like, vote, RSVP, follow, bookmark; meet RSVP. A shared `useOptimistic`-style helper so every module does it the same way. | 3 |
| **P-05** | Media that does not jump | The files service generates a **thumbnail** (320 px WebP) and a **blurhash** for images and a poster frame for videos when the upload finishes (worker job, `sharp` and `ffmpeg`, both free). Messages and posts carry width, height and blurhash, so the layout is reserved before the image loads. Media responses get `Cache-Control: private, max-age=31536000, immutable` on content-addressed URLs, and the service worker caches thumbnails. | 4 |
| **P-06** | Paged conversation list | `listConversations` currently returns every conversation with no limit. Page it (50 at a time, keyset on `last_message_at, id`), and send **changes since a cursor** instead of the full list on reconnect. The store keeps the full list the user has scrolled through. | 2 |
| **P-07** | Skeletons and transitions | Skeletons sized like real rows (no spinners in lists), list-to-detail transitions on phones (View Transitions API where supported, a CSS slide otherwise), and pressed states on every tappable row. **Target T9.** | 2 |
| **P-08** | Network efficiency | Enable **brotli** in nginx (and keep gzip as a fallback), HTTP/2 on both subdomains, `immutable` caching for hashed assets, and self-host the Google Fonts (OPS-08). Turn on Socket.IO `perMessageDeflate` for messages over 1 KB. | 1 |
| **P-09** | Prefetch what is next | When the conversation list renders, prefetch the newest 40 messages of the top 5 unread conversations into the store (once, at idle). The same for the newest 3 unread mail threads. Opening them is then instant, as in WhatsApp. | 1.5 |

**Workstream P total:** about 25.5 dev-days.

### 5.3 Workstream S: sync and delivery (patterns 3, 4, 5)

Remediation made the realtime path correct. This workstream makes it **complete across disconnections, devices and restarts**, which is SRS §9.1 (CHAT-H4).

| ID | Task | Detail | Est. |
|---|---|---|---|
| **S-10** | Per-user change log | A `user_events` table (partitioned by month, with the same maintenance as `messages`): `(user_id, seq BIGSERIAL-per-user, kind, ref_id, payload_small, created_at)`. Every change a user must see (new message summary in any conversation, read state, membership, mail arrival or move, notification, feed item for the home feed, meeting invite) writes one row per affected user **in the same transaction** as the change. Fan-out to large channels is done by the worker in batches, so a 500-member channel post does not slow the send. Kept for 30 days. | 5 |
| **S-11** | Sync protocol | `GET /api/sync?since=<seq>` returns the events after the cursor (up to 500, then `hasMore`), or `{reset:true}` when the cursor is older than retention. Socket events carry the same `seq`, so a client that sees a gap (got 41, expected 39) calls sync. On connect, reconnect, `visibilitychange` to visible and `online`, the client calls sync before anything else. The store's cursor only moves forward after events are applied. **Target T6.** | 4 |
| **S-12** | Delivery receipts for real | Today "delivered" means "read by at least one person" (CHAT-H7). The client sends a batched `receipt:delivered` (conversation id, up to seq) when events reach the store, even with the conversation closed. Receipts are stored as **per-member watermarks** (`delivered_seq`, `read_seq` on the membership row) instead of one row per message per member, which also fixes CHAT-M8's O(N) growth. Ticks: one grey (sent), two grey (delivered to every member's device), two coloured (read), with "Read by" and "Delivered to" in message info for groups. The receipt-privacy rule from B-11 still applies. | 4 |
| **S-13** | Polling fallback | When WebSocket and long-polling both fail (some school networks), the client falls back to calling `/api/sync` every 10 s and shows "Limited connection". SRS §9.3. | 1 |
| **S-14** | Ordering and idempotency audit | One test suite that sends from three devices with random delays, kills the realtime process mid-burst, reloads one client and toggles offline, then checks every device ends with the same messages in the same order, each once. This becomes `verify:sync` and runs nightly. | 2 |
| **S-15** | Mail and feed on the same rail | Mail arrival, read and move events and feed new-post and engagement events use the change log too, so every module gets the same catch-up. Mail read state then syncs across devices (MAIL-M3) as a side effect. | 2 |

**Workstream S total:** about 18 dev-days.

### 5.4 Workstream N: notifications that reach people (pattern 6)

The notification centre, the shared unread store, web push and the email digest exist on the branch (F-01 to F-04). This workstream brings them to the standard of a phone messaging app.

| ID | Task | Detail | Est. |
|---|---|---|---|
| **N-01** | Server-side quiet rules | Mute, per-conversation notification level, do-not-disturb, quiet hours (in the user's own time zone) and the status picker are applied **when the server decides to push**, not only in the browser (CHAT-M4, NOTIF-06). | 2 |
| **N-02** | Collapse and replace | Push uses a tag per conversation and `renotify`, so five messages in one chat show as one notification ("5 new messages from Alice") that updates, not five. Reading on any device removes the notification on the others (a silent push that closes it). | 2 |
| **N-03** | Reply and mark read from the notification | Notification actions "Reply" and "Mark as read" (supported in Chrome on Android and desktop). The service worker posts through the outbox, so it also works offline. | 2 |
| **N-04** | App-icon badge everywhere | `navigator.setAppBadge` driven by the shared unread store, also updated from the service worker when a push arrives with the tab closed. | 0.5 |
| **N-05** | Incoming call experience | A ringing screen for 1-to-1 and group calls started from a conversation: ringtone, Accept and Decline, a missed-call message in the chat, and a high-priority push to closed tabs. The header call buttons start the call (they did nothing in the gap analysis). | 4 |
| **N-06** | Push health | Track push sends, failures and expired subscriptions (remove them on 404 or 410). Show "Notifications are off on this device" with a fix-it button when permission is denied or the subscription is gone. | 1.5 |
| **N-07** | iOS reality | Web push on iPhone works only for an **installed** PWA (iOS 16.4 and later). The install prompt (F-09) must say so on iOS, and the settings page must show whether this device can receive push. The NGA Desktop app (Tauri) already shows native notifications; keep it on the same events. | 1 |

**Workstream N total:** about 13 dev-days.

### 5.5 Workstream U: interaction parity per module

What users compare against. Items already done on the branch are not repeated. Open remediation tasks are folded in (C-14, C-15, E-05 to E-11).

#### Chat (compare: WhatsApp, Slack)

| ID | Task | Est. |
|---|---|---|
| **U-01** | **Gestures on phones:** swipe a message right to reply, long-press for the action sheet with reactions on top (replacing the hover toolbar, UX-7), swipe a conversation row for archive, mute and mark read. Haptics where available (`navigator.vibrate`). | 3 |
| **U-02** | **Voice notes like WhatsApp:** hold to record, slide to cancel, lock for hands-free, a real waveform (computed in the worker), playback speed 1×/1.5×/2×, and voice notes keep playing while the user scrolls or switches conversation. Transcoding to Opus in the worker (FR-MSG-20). | 4 |
| **U-03** | **Media gallery and viewer:** full-screen swipeable viewer for images and videos in a conversation, pinch to zoom, save, forward; a send preview with caption and several images at once, compressed on the device before upload. | 3 |
| **U-04** | **Message info and search jump:** message info (sent, delivered and read times per member, from S-12); jump to date (FR-MSG-16); "load newer" after a jump (CHAT-M14); search results with highlighted context. | 2.5 |
| **U-05** | **Slack-style power features:** saved items ("Later"), a Threads view across conversations (built on B-02's thread read state), custom sidebar sections (FR-CHN-10), `/remind /away /invite /archive` (FR-MSG-26), code highlighting and maths (FR-MSG-3), custom emoji and skin tones (FR-MSG-5). | 6 |
| **U-06** | **Presence that is right:** "online", "last seen 5 min ago", "typing…" and "recording audio…" in the header and list, all honouring the hide-presence setting (CHAT-M11). | 1.5 |

#### Mail (compare: Gmail)

| ID | Task | Est. |
|---|---|---|
| **U-10** | **Undo send** (a 5–10 s hold, configurable in settings), **snooze**, and keyboard shortcuts `j k e r a # /` with a `?` cheat sheet. | 3 |
| **U-11** | Remediation **C-14**: campaign, list and template screens, report page, suppression screen, time-zone fixes, approver notifications. | 4 |
| **U-12** | Remediation **C-15**: Sent paged in the database, external attachments, attachments kept on forward, standard mail headers and bounce feedback. | 4 |
| **U-13** | Conversation view like Gmail: collapsed older messages, quoted text hidden behind "…", and an inline reply with Cc and attachments. | 2 |

#### Feed (compare: Facebook)

| ID | Task | Est. |
|---|---|---|
| **U-20** | **Pull to refresh** on phones, scroll position kept on Back (D-08 did this for some routes; finish it for every route), and the "new posts" pill that respects the current filter. | 1.5 |
| **U-21** | **Media posts:** multi-image grid with the viewer from U-03, video autoplay muted in view and paused out of view, upload progress in the composer. | 3 |
| **U-22** | **@mentions resolved and notified, hashtags filter**, share to chat as a card (FR-FEED-11), rich-text posts rendered (FR-FEED-2). | 4 |
| **U-23** | Reactions reachable by keyboard and long-press with a picker like Facebook's (accessibility gap in §7.4 of the report). | 1 |

#### Meet (compare: Google Meet, WhatsApp calls)

| ID | Task | Est. |
|---|---|---|
| **U-30** | Remediation **E-05 to E-07**: device switching during a call, audio-only fallback, host experience, SFU connection recovery, a reconnecting banner. Also move meeting room state into Redis so a realtime restart (R-02) does not lose the lobby or spotlight (MEET-RT3). | 10 |
| **U-31** | Remediation **E-08 and E-09**: scheduling, recordings saved safely with chunked upload, AI summary once per meeting. | 8 |
| **U-32** | Remediation **E-10 and E-11**: breakouts finished or hidden, meet polish. | 9 |
| **U-33** | **Phone call layout:** speaker view by default with one-tap switch to grid, grid paging so a phone decodes at most 4 videos, picture-in-picture when the user leaves the call screen. | 3 |

#### Shell and files

| ID | Task | Est. |
|---|---|---|
| **U-40** | **Global search** (`Ctrl/⌘ K`) across people, conversations, messages, mail and posts, with `from: in: has: before:` operators, using Postgres full-text plus `pg_trgm` for typos (P3-04). | 5 |
| **U-41** | **Files module:** a "Shared with me / My files / By conversation" view built on the existing files service, or remove the tab until it is ready (FILE-06, P3-02). | 5 |
| **U-42** | **Languages:** English, Kinyarwanda and French with a per-user switch (P3-01). Start with the shell, chat and notifications; mail, feed and meet follow. | 8 |
| **U-43** | **Accessibility pass** (P3-10): page headings, labels, focus traps, `aria-live` regions, 24 px targets, keyboard access to every menu. | 4 |

**Workstream U total:** about 94.5 dev-days (of which about 35 are remediation tasks carried over).

### 5.6 Workstream Q: scale and data

Keeps every target true as the school uses Tupo more.

| ID | Task | Detail | Est. |
|---|---|---|---|
| **Q-01** | Missing indexes | `messages(conversation_id, id)` (CHAT-M7), `audit_logs(created_at)` if not already covered by 0040, trigram indexes for search (with U-40). Built `CONCURRENTLY`. | 1 |
| **Q-02** | Query budget | Log any request with more than 20 queries or more than 200 ms of DB time in development and CI. Fix what it finds, starting with the conversation list, the mailbox and the home feed. | 3 |
| **Q-03** | Socket event budget | Rate limits exist (A-05). Add per-event payload size limits, coalesce typing to one broadcast per 2 s per user, and send presence changes only to people who can see them, in batches. | 2 |
| **Q-04** | Load test | k6 scripts (free) for 1,500 sockets, 50 messages/s, 20 % of users scrolling history, 100 feed loads/s. Run against a production-sized copy on a developer machine or a temporary free-tier VM, never against the shared production box during school hours. **Target T10.** | 3 |
| **Q-05** | Retention jobs | Notifications older than 90 days, read `user_events` older than 30 days, expired stories and drafts, trash older than 30 days, and orphaned files, all removed by worker jobs in small batches. | 2 |

**Workstream Q total:** about 11 dev-days.

---

## 6. Order of delivery

Milestones are sequenced by what users feel and what each one depends on. Dates assume 3 developers and part-time QA (about 13 dev-days a week, after review and meetings). With the 5-developer team from the remediation plan, divide the durations by about 1.6.

| Milestone | Contents | Est. | Window | Users will notice |
|---|---|---|---|---|
| **M0: Safe** | S-01 to S-06 | 5 | **3–7 Nov** | Chat works again (if it was broken); every Critical finding closed in production |
| **M1: Never down** | R-01 to R-07, Q-01, P-08 | 13.5 | 10–21 Nov | Deploys no longer interrupt anyone; the team gets alerts before users complain |
| **M2: Instant** | P-01 to P-07, P-09 | 24.5 | 24 Nov–12 Dec | The app opens immediately with the last state; conversations open instantly |
| **M3: Never miss a thing** | S-10 to S-15, N-01 to N-04, N-06, N-07 | 27 | Jan 2027 (first 2 weeks before the school break if capacity allows) | Correct ticks, no gaps after being offline, one tidy notification per chat, reply from the notification |
| **M4: Feels familiar** | U-01 to U-04, U-06, U-10, U-13, U-20, U-21, U-23, N-05, U-33 | 31.5 | Feb 2027 | Swipe to reply, voice notes, media viewer, undo send, calls that ring |
| **M5: Complete** | U-11, U-12, U-30 to U-32 (remediation carry-over), U-05, U-22 | 45 | Mar–Apr 2027 | Mail campaigns and Meet at full strength; Slack-style power features |
| **M6: For everyone** | U-40 to U-43, Q-02 to Q-05 | 32 | Apr–May 2027 | Search everything, Files, Kinyarwanda and French, accessible everywhere |

**Total:** about 173.5 dev-days beyond step zero (R 11.5 · P 25.5 · S 18 · N 13 · U 94.5 · Q 11).

```
Nov ── M0 Safe ── M1 Never down ── M2 Instant ──┤ Dec
Jan ── M3 Never miss a thing ──┤ Feb ── M4 Feels familiar ──┤
Mar ── M5 Complete ─────────────┤ Apr ── M6 For everyone ──┤ May
```

If capacity is tight, **M0, M1 and M2 are the ones that change how Tupo feels.** The order inside M4 to M6 can change with feedback from users.

---

## 7. Database migrations

Numbered after whatever `main` holds once S-02 lands (shown here as `+1`, `+2`, …).

| # | Task | Purpose | Production notes |
|---|---|---|---|
| +1 | S-10 | `user_events`, partitioned by month, with the partition maintenance extended to it | Same safety net as `messages`: DEFAULT partition and the months-ahead alert |
| +2 | S-12 | `delivered_seq` and `read_seq` on conversation membership; backfill from `message_receipts`; stop writing per-message receipts after one release | Expand, then contract: drop `message_receipts` writes one release later |
| +3 | P-05 | `width`, `height`, `blurhash`, `thumb_key`, `poster_key` on files | Backfill thumbnails in the worker, newest first, at a low rate |
| +4 | Q-01 | Indexes, built `CONCURRENTLY` (`-- migrate:no-transaction`) | Off-peak |
| +5 | U-10 | Mail `undo_until`, `snoozed_until` | none |
| +6 | U-05 | Saved items, sidebar sections, custom emoji | none |

Rules from the remediation plan still apply: `pg_dump -Fc` before each production migration, never auto-seed role permissions, and every migration backward-compatible with the previous release (R-06).

---

## 8. Risks and trade-offs

| Risk | Impact | Mitigation |
|---|---|---|
| Production chat has been down since 1 Nov | Users have lost trust in Tupo | S-01 today; a short honest note to staff once it is fixed |
| The rebase and migration renumbering goes wrong | A failed deploy, or migrations recorded under the wrong name | Rehearse `db:migrate` on a restored copy of `tupo_prod` first (S-02) |
| On-device storage shows stale or wrong data | Confusion; a privacy risk on shared devices | Per-account stores, cleared on sign-out; sync reset when the cursor is too old; never cache admin or oversight data |
| `user_events` fan-out for big channels | Slow sends; a large table | Fan-out in the worker for channels over 50 members; monthly partitions; 30-day retention |
| The shared box runs out of memory | All four NGA apps degrade | Memory budget per process in pm2 (`max_memory_restart`); load test (Q-04) before raising the API to 2 instances; R-04 alerts on free memory |
| iOS users don't get push | Missed messages | Explain installation clearly (N-07); email digest as the fallback (F-04) |
| Scope creep while chasing "the big apps" | Late delivery of the work that matters | Only M0 to M2 are committed; M3 onward is reviewed against user feedback after each milestone |
| One developer owns most of the context | Knowledge risk | Each milestone ends with a short handover note in `docs/` and tests that describe the behaviour |

---

## 9. How we know it worked

### 9.1 New quality gates

| Gate | Runs | Blocks |
|---|---|---|
| Bundle-size budget (T3) | Every PR | Merge |
| Lighthouse CI on Chat, Mail and Feed with phone throttling (T2, T9) | Every PR | Merge on a regression of more than 10 % |
| `verify:latency` (T4) and `verify:sync` chaos probe (T6) | Nightly and before each release | Release |
| Deploy probe: send during `pm2 reload` (T8) | Each release, in production, with a test account | Rollback |
| Push probe (T7) | Nightly | Alert |
| k6 load test (T10) | Before M2, M3 and M6 releases | Release |

### 9.2 Signals from production (from R-04 and R-05)

- p95 send-to-deliver, socket reconnects per hour, sync resets per day.
- Client errors per 1,000 sessions, and their top fingerprints.
- Push delivery rate, and the share of active users with push enabled.
- Weekly active users per module. This is the real measure of whether Tupo now feels like the apps people choose to use.

### 9.3 Re-run the gap analysis

At the end of M3 and again at the end of M6, re-run every `gap-*` and `gap2-*` probe and publish a short "remaining gaps" addendum next to the original report.

---

## 10. Immediate next steps

1. **Today:** run the production partition check (S-01) and fix it if chat is down.
2. **This week:** rebase and renumber (S-02), full regression (S-03), production prerequisites (S-04), deploy (S-05).
3. **Product owner:** confirm the targets in §2 and the milestone order in §6, especially whether M2 (instant start) comes before M3 (complete sync).
4. **Leads:** create tracker issues for M0 and M1 with the IDs from this plan, and link the remaining remediation tasks (C-14, C-15, E-05 to E-11) to U-11, U-12 and U-30 to U-32.

---

## 11. Implementation status

Branch `feat/responsiveness`, cut from `feat/gap-remediation` with `main` merged in. **Not pushed or deployed:** pushing to `main` deploys to production, so that step waits for the release owner. Each item lists the check that proves it. "Live" means run in a real browser or against real sockets on the local stack.

### M0: Safe

| ID | Status | Notes |
|---|---|---|
| S-01 | ⏳ Needs production access | The read-only partition query in §4 must be run on `tupo_prod`. This session could not reach production. |
| S-02 | ✅ Done (`4f26894`) | `main` (PRs #35 to #37) merged into the remediation branch. **No renumbering was needed:** the migration runner records file names and applies any missing file in sorted order, so `main`'s `0030_subject_channels` and `0031_user_mis_status` sit beside the branch's `0031` to `0042`. 23 conflicts resolved. Roster status semantics now follow `main` (active by default); the branch's notification centre replaces `main`'s simpler bell. |
| S-03 | ✅ Local regression green | Typecheck clean; 760 unit and API tests; every backend `verify:*` suite. The suites that assumed AI was available now treat a school-wide AI switch-off (`AI_DISABLED`, the MIS default) as "unavailable". |
| S-04, S-05 | ⏳ Release owner | Backup drill, VAPID keys, `pg_dump`, deploy order, mail backfill. Unchanged from the remediation plan. |
| S-06 | ✅ Done (`65a398c`) | nodemailer 10.1.7, body-parser 1.20.9, markdown-it 14.3.3. **Found and fixed** an existing production bug: every outbound mail showed the sender as `"Name>"`, because `MAIL_FROM` was wrapped twice. zod 3 (high, memory on oversized input) remains; its only fix is the zod 4 major. The CI audit gate stays at critical until then. |

### M1: Never down

| ID | Status | Evidence |
|---|---|---|
| R-01 | ✅ (`e913165`) | 2 pm2 cluster instances with `wait_ready`; shared limits and replay checks in Redis. pm2 7.0.4 locally, 25 s of traffic through two reloads: **0 errors in 11,629 requests**. Fork mode (production today) refused 840. |
| R-02 | ✅ (`bcca66e`) | `verify:realtime:restart` 6/6: all 30 clients notified before close, exit in about 0.4 s, all back, reconnects spread over about 2.9 s. |
| R-03, R-04, R-05, R-07 | ✅ (`3d3a498`) | Metrics, 12 alert rules (email and Telegram), grouped browser and server errors, System page. `verify:monitoring` 14/14 live; 9 API and alert tests; 3 fingerprint tests. Redis: one instance-wide `noeviction` ceiling (BullMQ requires it), not per-database policies as first planned. See `docs/OPERATIONS_MONITORING.md`. |
| R-06 | ✅ (`640625a`) | `scripts/release.sh` snapshot, keep-assets, rollback and list, exercised in a sandbox. |
| Q-01 | ✅ (`3d3a498`) | `messages(conversation_id, id)` (migration 0044); the plan now uses the index. |
| P-08 | ✅ (`de426ff`) | Immutable `/assets/`, revalidated shell, gzip including the API's JSON, `http2 on`, brotli ready to switch on, self-hosted fonts (0 requests to Google). `nginx -t` must be run on the host when applied. |

### M2: Instant

| ID | Status | Evidence |
|---|---|---|
| P-01 | ✅ (`2f4397d`) | First load **512 KB → 232 KB** gzip (26 files); a CI budget fails over 250 KB. |
| P-02, P-03, P-07, P-09 | ✅ (`ea6bafc`) | `verify:local-first` 15/15: with the API cut, chat, mail and feed render from the device; an unread conversation never opened was prefetched; warm open in **about 80–110 ms** with the API held back 2.5 s; sign-out deletes the device copy. |
| P-04 | ✅ (`65744ef`) | `verify:optimistic` 8/8 with every write held back 2.5 s: mail star, archive, labels and a refused unstar rolling back with a message; chat poll vote in 3 ms; feed follow. Also fixed: chat reactions refused by the server now bounce back (before, they stuck), and unpin, mark unread, poll and RSVP failures are now shown, not swallowed. |
| P-05 | ✅ (`463c005`) | `verify:media` 10/10: a WebP thumbnail plus blurhash, made in 142 ms for a 3000×2000 photo; backfill on first request; images cached by the service worker (each view used to download again, because the ticket changed the URL); cleared on sign-out. |
| P-06 | ➖ Measured, deferred | The list query takes **2 ms for 400 conversations**. With local-first in place, the screen no longer waits for it. Paging would complicate unread totals for no measurable gain at school scale. |

Found and fixed while testing M2: with local-first, "load older" could run on the device copy's oldest message after the network page had replaced it. It then read the empty answer as the end of history. `verify:chat:ui` caught it; the suite is back to 158/158.

### M3: Never miss a thing

| ID | Status | Evidence |
|---|---|---|
| S-10 | ➖ Replaced | The planned `user_events` fan-out log was not needed. Reconnect catch-up (B-04), delivered receipts (B-11) and per-conversation sequence numbers already carried most of it. The remaining holes are closed directly in S-11, with no table that grows by members × messages. |
| S-11, S-13, S-14, S-15 | ✅ (`56b673e`) | Paged catch-up (it used to stop at 100), gap detection on a sequence jump, resync when returning to the tab, on `online` and on reconnect, a 15 s poll while the socket is down, and the same triggers for Mail and the bell. `verify:sync` 6/6: 150 and 250 messages arriving offline all shown once, in sequence order; a hole from a never-broadcast event filled; mail and the bell caught up without a reload. |
| S-12 | ✅ (`0ca4763`) | Read receipts touch only what is new since the last read (CHAT-M8). Per-message delivered and read ticks already existed (B-11). |
| N-01 to N-04 | ✅ (`09828b2`) | Push respects Do not disturb; repeats stack into "N new messages"; "Mark as read" from the notification; read here or on another device clears it; app-icon badge from push. `verify:push-ui` 8/8 in full headless Chrome; push tests 6/6. |
| N-06, N-07 | ✅ Already in place | Dead subscriptions removed (F-04); Settings explains "blocked" and the iPhone Home Screen requirement. |
