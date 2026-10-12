# Tupo Remediation: Delivery Plan

| | |
|---|---|
| **Status** | Draft for team review |
| **Date** | 12 October 2026 |
| **Input** | [`GAP_ANALYSIS_2026-10-12.md`](GAP_ANALYSIS_2026-10-12.md) and the evidence folder [`gap-analysis-2026-10-12/`](gap-analysis-2026-10-12/) |
| **Audience** | Tupo developers, QA and the release owner |
| **Fixed deadline** | **24 Oct 2026**: the database partition work (task A-01) must be in production well before 1 Nov 2026 |

> This plan covers **who does what, in which order, and how we know it is done**. The *why* and the file:line evidence for each item are in the gap analysis report. Every task lists the finding IDs it closes; open the report at that ID for the details.

---

## 1. Objectives

1. Remove every outage risk and every finding that lets one user see or change data they shouldn't.
2. Make unread counts, notifications and live updates match reality in every module.
3. Ship the missing features users notice most.
4. Put automated quality gates in place so these problems cannot come back silently.

---

## 2. Working agreements

- **One shared mechanism per problem class.** Several findings share a root cause, such as missing input validation, missing access checks, or broadcasts carrying one user's personal state. Build the shared helper once, then apply it everywhere. Do not patch endpoints one by one.
- **Every PR names its finding IDs** in the title or description, for example `fix(chat): thread unread model (CHAT-U1, CHAT-U2)`.
- **Every fix ships with a regression test.** That is a unit test, a `verify:*` check, or a probe check promoted into `verify:*`. The test must fail before the fix and pass after it.
- **Security-sensitive changes need two reviewers.**
- **Migrations:** numbered from `0031` upward, reviewed by the backend lead, and applied in production only after a `pg_dump` backup.
- **Definition of done:**
  - Code merged.
  - Tests green in CI.
  - Deployed.
  - The relevant probe re-run.
  - Finding status updated in the tracker (§10).

---

## 3. Team and workstreams

The plan assumes 5 developers and 1 QA. Replace the role names with people when the plan is accepted.

| Workstream | Lead role | Owns |
|---|---|---|
| **A: Platform** | Backend lead | Error handling, validation, rate limits, partitions, files service, realtime gateway, session and roles |
| **B: Chat** | Fullstack dev 1 | Chat correctness, the unread model, threads, composer, chat navigation |
| **C: Mail** | Fullstack dev 2 | Mail correctness, mailbox state, delivery, campaigns |
| **D: Feed** | Fullstack dev 3 | Feed audiences, live updates, drafts, reels and stories, moderation |
| **E: Meet** | Fullstack dev 4 | Meeting access, lobby, reconnect, attendance, recording, scheduling |
| **F: Shell & notifications** | Frontend devs from B and C | Notification centre, navigation badges, deep links, error boundary, PWA, admin screens |
| **G: Quality & ops** | QA, with the backend lead | CI gate, regression suites, backups, monitoring, test-data hygiene |

---

## 4. Timeline

| Phase | Dates | Theme | Exit criteria |
|---|---|---|---|
| **0: Stabilise** | 13 to 24 Oct | Outage risks and the most serious data-exposure findings | Every Phase 0 task is in production; the security and realtime probes show no Critical failures |
| **1: Correctness** | 27 Oct to 14 Nov | Access checks everywhere, realtime correctness, the unread model, CI gate | Every High finding in §5–§8 of the report is closed; CI blocks failing builds |
| **2: User experience** | 17 Nov to 19 Dec | Notifications, badges, deep links, mail/feed/meet journeys, admin screens | Journey probes green; no Critical or High findings left open |
| **3: Completeness** | Jan to Feb 2027 | SRS features, i18n, performance, accessibility | Backlog groomed, then the gap analysis is re-run |

```
Oct 13 ─── Phase 0 ───┤ Oct 24 ── Phase 1 ──┤ Nov 14 ── Phase 2 ──┤ Dec 19 ── Phase 3 (2027) ──▶
   A-01 partitions (deadline 24 Oct)
   CI gate (G-01) lands in Phase 0 so every later PR is gated
```

---

## 5. Phase 0: Stabilise (13 to 24 Oct)

Each task lists its ID, workstream, findings closed, scope, how it is accepted, its estimate in developer-days, and what it depends on.

| ID | WS | Closes | Scope | Acceptance | Est. | Depends |
|---|---|---|---|---|---|---|
| **A-01** | A | X-01, MEET-BUG5 | Monthly partitions for `messages` and `meeting_events` created months ahead by a daily worker job, plus default partitions as a safety net and a health metric for "months ahead". Migration `0031`. **First step: check which partitions exist in production.** | Inserting a row dated 3 months ahead succeeds; production shows partitions through Jan 2027; health endpoint reports at least 2 months ahead | 1.5 | none |
| **A-02** | A | X-02, X-03, X-04, MEET-SEC2, MEET-SEC7 | One error-handling layer for API, realtime and files: async route wrapper, safe socket-handler wrapper, error-catching auth middleware, stream error handlers, process-level logging, central error responses | The crash section of `gap-security-probe.mjs` passes and every service stays up | 2 | none |
| **A-03** | A | X-05 (first cut) | Basic per-user rate limits on the busiest write paths and socket events, Redis-backed | The burst checks in `gap-realtime-probe.mjs` get throttled; all `verify:chat*` scripts still pass | 1 | none |
| **C-01** | C | MAIL-C1 | Strict validation of the mailbox folder parameter and parameterised queries. Sweep all packages for string-built SQL and record the result in the PR | Mail security checks in `gap-realtime-probe.mjs` pass; new unit test | 0.5 | none |
| **C-02** | C + A | MAIL-C2, MAIL-H8, X-07 | Shared HTML sanitiser on the server for mail, templates, campaigns, signatures and AI output; a matching sanitiser on render; escaped merge values; backfill script for stored mail; security headers on the SPA, rolled out in report-only mode first | XSS check in `gap-ui-probe.mjs` passes; report-only logs clean for 3 days, then enforce | 2 | none |
| **C-03** | C | MAIL-C3, MAIL-H1, MAIL-H3, MAIL2-04 | Drafts and scheduled mail keep their recipients privately until actually sent; recipients' mailboxes only change at send time; "Continue editing" and "Cancel scheduled send" keep all recipients and attachments. Migration `0032` moves existing draft data | Probe checks for draft and scheduled-mail visibility pass; 3 new `verify:mail` checks | 2 | none |
| **D-01** | D | FEED-S2, FEED-A1, FEED2-01, FEED-B2 | One "can this user see this post" guard used by every feed read and engagement path (posts, comments, reactions, polls, RSVP, bookmarks, views, shares, reels). A post's audience can never be wider than its page's. Follower notifications and live pushes are filtered by audience. Deleted pages disappear from feeds | Feed audience checks in the probes pass; new `feed.test.ts` cases | 2.5 | none |
| **B-01** | B | CHAT-C1, CHAT-C2, CHAT-M2 | Only allowed message types are accepted from clients; per-type metadata validation with a size cap; moderators can remove any message; edit history, reactor lists and polls are scoped to their conversation | Chat integrity checks in `gap-security-probe.mjs` pass | 1 | none |
| **E-01** | E | MEET-SEC5, MEET-SEC6 | One "can this user access this meeting" guard on every meeting read route (details, AI notes, attendance, recordings, ICS, transcript, notes); guest tickets bound to their own meeting and expired when it ends | Meet access checks in `gap-security-probe.mjs` pass | 1.5 | none |
| **G-01** | G | OPS-01, OPS-05 | CI workflow that runs build, typecheck, unit tests and `npm audit` on every PR; deploy only after CI passes; typecheck builds local packages first; fix the order-dependent feed test and add a test file to `@tupo/feed` | A red PR cannot be merged; `npm test` exits 0 on `main` | 1.5 | none |
| **G-02** | G | OPS-02 | Nightly `pg_dump` of `tupo_prod` and an rsync of `/var/lib/tupo/storage` to off-box storage, with 14-day retention and a documented restore drill | One successful restore into a scratch database | 1 | none |

**Phase 0 total:** about 16.5 developer-days across 6 people, which fits in 2 weeks with review time.

### Phase 0 release checklist

- [ ] Production partition check done; A-01 deployed and verified.
- [ ] Database backup taken before migrations `0031` and `0032`.
- [ ] Mail backfill dry run reviewed, then executed.
- [ ] Security headers in report-only mode, with logs watched.
- [ ] All `verify:*` scripts plus the three `gap-*` probes green against local or staging.
- [ ] Staff notice: "Mail drafts are no longer visible to recipients; please re-check any scheduled messages."

---

## 6. Phase 1: Correctness (27 Oct to 14 Nov)

### 6.1 Featured task: B-02, chat unread model

**Closes:** CHAT-U1 to CHAT-U15, CHAT-H8 (the user-reported "replies always look new" problem, and the missing unread counts). **Owner:** workstream B. **Estimate:** 5 days, plus 1 day of QA.

**Decision needed before work starts (product owner):** do thread replies count toward the conversation badge?

- **Recommended:** no, unless the reply is also sent to the channel. Threads get their own "N new replies" state and a **Threads** view, as in Slack and Teams.

**Deliverables:**

| # | Deliverable | Where |
|---|---|---|
| 1 | Unread increment and recount follow the decision above, consistently, on every send path | `packages/chat/src/service.ts` (send, read, recount) |
| 2 | Per-thread read state, plus endpoints to mark a thread read and to list threads with unread replies. Migration `0033` | `packages/db/migrations`, `routes/chat.ts` |
| 3 | **One-off recount** of every member's counters, to clear the badges already stuck in production | Part of migration `0033` |
| 4 | The thread-reply route announces updated counters, the same way the normal send path does, through one shared "after send" function | `routes/chat.ts`, `apps/realtime/src/chat/handlers.ts` |
| 5 | Sidebar previews ignore thread replies unless they were also sent to the channel | `refreshPreview`, `ChatProvider.tsx` |
| 6 | The thread panel marks the thread read when it is scrolled to the end; the main view marks read to the conversation's last channel message | `ThreadPanel.tsx`, `MessageThread.tsx` |
| 7 | "N new replies" marker on thread roots, and a Threads list in the sidebar | `MessageThread.tsx`, `ConversationList.tsx` |
| 8 | Visible **Mark as read / Mark as unread** in the row menu and long-press menu, and **Mark all read** in the list header | `ConversationList.tsx` |
| 9 | Muted totals and expired mutes handled consistently in the launcher and the list | `ChatDock.tsx`, `ConversationList.tsx` |
| 10 | The "1 reply" link is no longer covered by the invisible hover toolbar | `MessageThread.tsx` (toolbar) |

**Acceptance:**
- `scripts/gap2-unread-probe.mjs` passes every check.
- It is promoted to `npm run verify:chat:unread`.
- `verify:chat:threads` gains live-badge and clear-on-read checks.

### 6.2 Phase 1 task list

| ID | WS | Closes | Scope | Est. | Depends |
|---|---|---|---|---|---|
| **A-04** | A | CHAT-M20, FEED-V1, MEET-SEC9, CHAT-M1 | Schema validation for every API route and socket event (bodies, query params, enum values, sizes) | 4 | A-02 |
| **A-05** | A | X-05, MAIL-M14, FEED-B11 | Full rate limiter: per user and route, an AI budget, deduplicated feed views and shares | 2 | A-03 |
| **A-06** | A | FILE-01, FILE-04, AUTH-03 | Files service uses the same session, suspension, revocation and permission checks as the API | 2 | none |
| **A-07** | A | FILE-02, FILE-05 | Real byte caps while uploading, per-user quotas, upload rate limit, clean-up of abandoned files, ticket expiry enforced | 3 | A-06 |
| **A-08** | A | CHAT2-01 | Media links refresh themselves, so voice notes and videos keep playing after 60 s | 1 | none |
| **A-09** | A | RT-02 to RT-06 | Realtime gateway reconnects to Redis, avoids duplicate delivery on multiple instances, re-checks sessions during long connections, refuses default secrets, limits presence lookups | 2.5 | A-02 |
| **A-10** | A | AUTH-02, ADMIN2-04 | Role-change safety: no assigning roles above your own, no removing the last role manager, confirmation for sensitive grants, before/after shown in the audit log | 2 | none |
| **A-11** | A | SHELL2-02 | Suspended accounts are refused at sign-in and shown a clear "account suspended" screen | 1 | none |
| **X-01** | A + B/C/D/E | X-06, FEED-R1 to R3, CHAT-H6 (payloads), MEET-SEC9 | Live broadcasts carry only shared data; each client works out its own state ("my reaction", "can edit", "my vote") | 4 | none |
| **X-02** | A + B/D/E | CHAT-H2, FEED-B5, MEET-SEC1, MEET-SEC3 | Room membership lifecycle: join a live room only after the access check; remove sockets when membership or audience changes; the meeting lobby is a separate room | 3 | X-01 |
| **B-02** | B | CHAT-U1 to U15, CHAT-H8 | Unread model (see §6.1) | 5 | B-01 |
| **B-03** | B | CHAT-H1, CHAT-H9, CHAT-H12, CHAT2-35 | One "may post here" rule and one shared action function per message operation, used by REST, socket and the scheduler | 3 | B-01 |
| **B-04** | B | CHAT-H3, CHAT-H4, CHAT-H5, CHAT2-08 | Typing indicator expires per person; catch-up after reconnect; a light activity update for conversations that aren't open; sidebar re-sorts on new messages | 3 | B-02 |
| **B-05** | B | CHAT-H11 | Block and report users: API, UI, enforced across DMs, mentions and presence | 3 | B-03 |
| **B-06** | B | CHAT2-04, CHAT2-05, CHAT2-21, CHAT-M13 | Sending reliability: length guard on Enter, failed messages can be discarded, failed uploads are never silently dropped, retry keeps attachments, replies land in the right conversation | 2 | none |
| **C-04** | C | MAIL-H2 | Each mail message is visible only to its own sender and recipients, also in search and AI summaries | 2 | C-03 |
| **C-05** | C | MAIL2-01, MAIL-H7, MAIL-M5 | Display-name limits, with the real account always shown; list members visible only to list managers; campaign preview limited to its owner and approvers | 1.5 | none |
| **C-06** | C | MAIL-H4, MAIL-H5, MAIL-H6, MAIL-M7 | Delivery robustness: no duplicate sends, stuck sends recovered, correct bounce handling, approval snapshot of recipients, SMTP rate limit | 4 | none |
| **C-07** | C | MAIL-M1, MAIL2-12, MAIL-H9 | Mail counts by conversation, not rows (also fixes the doubling); starred count correct; later replies raise a fresh notification | 1.5 | C-03 |
| **D-02** | D | FEED-S1, FEED-A2, FEED-V3, FEED-V4 | Page images must be the owner's own uploads; only authors edit comment text; reel limits enforced on the server; safe values for colours and backgrounds | 2 | D-01 |
| **D-03** | D | FEED-B3, FEED-B4, FEED-B10, FEED-B12, FEED-P4 | Scheduled posts announce themselves when they go live; safe poll voting; accurate counters; follower notifications moved to the worker | 3 | D-01 |
| **D-04** | D | FEED-L1, FEED-B6, FEED-B7, FEED-B8, FEED-B9 | Live updates reach the post page and new posts; no duplicate replies; edits render live; comment counts stay right | 2 | X-01 |
| **E-02** | E | MEET-SEC4, MEET-SEC8, MEET-SEC10, MEET-SEC11 | Calls from a conversation are private to its members by default; feature switches need the matching permission; short-lived per-person relay credentials; validation on create | 3 | E-01 |
| **E-03** | E | MEET-RT1, MEET-BUG1, MEET-BUG2 | Reconnect returns you to the call, not the lobby; attendance is measured in segments so rejoining doesn't inflate it; one participant record per person | 3 | none |
| **E-04** | E | MEET-RT2, MEET-RT6 | Meetings close themselves when empty or abandoned; ending from any screen tells everyone in the call; wrap-up runs exactly once | 2 | E-03 |
| **G-03** | G | OPS-06, OPS-07 | Promote the `gap-*` and `gap2-*` probes into named `verify:*` suites; fix the harness rot in the meet UI suites; run the suites nightly against staging | 3 | G-01 |
| **G-04** | G | X-08, data hygiene | Probe and verify clean-up deletes everything it creates (feed pages, files); add a `files` step to `scripts/lib/purge.mjs` | 1 | none |

**Phase 1 total:** about 70 developer-days (A 17.5 · cross-cutting 7 · B 16 · C 9 · D 7 · E 8 · G 4), which is roughly 3 weeks for 5 developers plus QA.

---

## 7. Phase 2: User experience (17 Nov to 19 Dec)

### 7.1 Shell, notifications and navigation (workstream F)

| ID | Closes | Scope | Est. | Depends |
|---|---|---|---|---|
| **F-01** | NOTIF-01, NOTIF-06, CHAT-U15 | **Notification centre:** a panel behind the bell with unread count, grouping by kind, mark read and mark all read, and deep links. Reading a conversation clears its notifications. Remove the placeholder red dot | 4 | B-02 |
| **F-02** | NOTIF-02 | One notification bridge for every kind (chat, mail, feed, meet), with per-kind sound and desktop-notification rules | 2 | F-01 |
| **F-03** | CHAT-U5, MAIL-H10, NOTIF-05 | **Shared unread store** feeding badges on the desktop rail, the phone tab bar, the installed-app icon badge and the tab title, for Chat, Mail, Feed and Meet | 2 | B-02, C-07 |
| **F-04** | NOTIF-03 | Web push for closed tabs and the installed app (subscription storage, click opens the right screen), plus an email digest for unseen mentions and DMs | 5 | F-02 |
| **F-05** | CHAT2-02, CHAT2-03, NOTIF-04, SHELL2-04 | **URL-driven navigation:** the open conversation, thread, message and panel live in the URL; routes for conversation, message permalink, invite and campaign links; a real 404 page; phone Back returns to the list | 3 | none |
| **F-06** | SHELL2-01, SHELL2-12 | Error boundaries at the root and around each page; failed loads show "something went wrong, retry" instead of empty states (one shared pattern, then applied in chat, mail, feed, admin and search) | 2 | none |
| **F-07** | SHELL2-03, SHELL2-05, SHELL2-07 | Land on the first module the user can open; friendly access-denied page with a way home; permission changes picked up without reloading | 1.5 | none |
| **F-08** | SHELL2-06, SHELL2-08 | Session stays consistent across tabs (sign-out everywhere, no mixed identities); sign-in callback cannot be replayed into someone else's session; warn before replacing an active session | 2 | none |
| **F-09** | SHELL2-16, SHELL2-17, SHELL2-18 | PWA: the app shell works offline, users are prompted when a new version is available, and the install prompt appears only where it makes sense | 2 | none |
| **F-10** | SHELL2-09, SHELL2-10, SHELL2-11, SHELL2-21 | Theme choice sticks (with a "System" option); presence correct across tabs and in calls; a status picker (available, busy, do not disturb); toasts that respect hover and focus; a profile and settings page | 3 | none |

### 7.2 Chat journeys (workstream B)

| ID | Closes | Scope | Est. |
|---|---|---|---|
| **B-07** | CHAT2-06, CHAT2-07 | Profile cards on avatars, names and member rows; confirmation for "make owner", "remove member" and "disappearing messages"; show the active retention setting | 2 |
| **B-08** | CHAT2-15, CHAT2-16, CHAT2-18, CHAT-H6, CHAT2-17 | Thread panel at parity with the main view (attachments, actions, composer tools, paging, live updates, drafts kept on Esc); Esc handling ordered correctly; the dock opens the panel you asked for | 4 |
| **B-09** | CHAT2-10, CHAT2-11, CHAT2-22, CHAT2-33, CHAT2-38, CHAT2-41 | Composer polish: keyboard slash suggestions, mentions shown as names, scheduling with attachments, voice-note flow, correct texts and times | 3 |
| **B-10** | CHAT2-12, CHAT2-13, CHAT2-14, CHAT2-24, CHAT2-25, CHAT2-44, CHAT-H10 | Message rendering and actions: working pinned and call buttons, correct formatting of underscores and asterisks, video thumbnails, error feedback, a fuller message menu, forwarding fixed | 4 |
| **B-11** | CHAT-H7, CHAT-M5, CHAT-M6 | Read receipts shown live, with the privacy rule; poll fixes; disappearing messages update clients | 3 |
| **B-12** | CHAT2-19, CHAT2-20, CHAT2-27, CHAT2-29, CHAT2-30 | Search finds partial words; Media and Links tabs; directory paging; large-channel member lists; invite management screen | 3 |
| **B-13** | CHAT-M12, CHAT2-26, CHAT2-31, CHAT2-32, CHAT2-34 | Outbox scoped per account; channel owners can moderate their own channel; timed mute and hidden DMs; group vs channel wording; no invisible tap targets on touch | 3 |

### 7.3 Mail journeys (workstream C)

| ID | Closes | Scope | Est. |
|---|---|---|---|
| **C-08** | MAIL2-02, MAIL2-05, MAIL-M11 | **Folder actions:** Restore and Delete forever in Trash, Move to Inbox, Not spam, Empty Trash; one folder state per conversation; actions work in Sent, Drafts and Scheduled | 3 |
| **C-09** | MAIL2-03, MAIL2-06, MAIL2-14 | Labels stay on a conversation when replies arrive; label view covers every folder; rename and recolour labels | 2 |
| **C-10** | MAIL2-07, MAIL2-09, MAIL2-15, MAIL2-17, MAIL-M13 | Composer: new compose or forward replaces or opens a second draft properly; pasted address lists become chips; save on close with a "Draft saved" indicator; inline replies kept as drafts; no duplicate drafts | 3 |
| **C-11** | MAIL2-08, MAIL-M3, MAIL2-22, MAIL2-24 | Live mailbox: new mail merges in without clearing selection or position; read state syncs across devices; folder and label in the URL | 2 |
| **C-12** | MAIL2-10, MAIL2-23, MAIL-M12 | Phone row actions and a fuller bulk bar; thread toolbar (star, unread, move, print); reply buttons only for users who can send | 2 |
| **C-13** | MAIL2-11, MAIL2-16, MAIL2-18, MAIL2-19, MAIL2-20, MAIL2-21 | Templates fill merge fields or warn; AI available for replies; inline images uploaded properly; inserting templates or AI text doesn't wipe the body | 3 |
| **C-14** | MAIL2-25 to MAIL2-30, MAIL-M4, MAIL-M6 | Campaigns, lists and templates screens: detail and report page, confirmations, error messages, suppression screen, correct time zones, approver notifications and preview | 4 |
| **C-15** | MAIL-M2, MAIL-M9, MAIL-M10, MAIL-M8 | Sent folder without campaign floods, paged in the database; attachments delivered to external recipients and kept when forwarding; standard mail headers and bounce feedback | 4 |

### 7.4 Feed journeys (workstream D)

| ID | Closes | Scope | Est. |
|---|---|---|---|
| **D-05** | FEED-F1, FEED2-07, FEED2-08 | **Drafts and scheduled posts screen** for page editors: list, edit, publish, reschedule; "Save draft" never schedules; a usable date/time picker | 3 |
| **D-06** | FEED2-02, FEED2-03, FEED2-09, FEED2-20, FEED2-32 | Composer fixes: photo button on the collapsed composer works; editing keeps poll and event changes; story audience picker; only allowed audiences listed; confirm before discarding | 2.5 |
| **D-07** | FEED2-04, FEED2-05, FEED2-06, FEED2-22, FEED2-23, FEED2-27, FEED2-28, FEED-B1 | Error and empty states across feed screens; a failed "load more" keeps the posts; report dialog shows the server message; a bad link preview can't break a card (server-generated previews) | 3 |
| **D-08** | FEED2-10, FEED2-11, FEED2-19, FEED2-21, FEED2-29, FEED2-30 | Scroll position kept on Back; comments newest-first with a real sort; follow state shared across screens; delete updates instantly; deep links to the exact comment; in-app links | 3 |
| **D-09** | FEED2-12, FEED2-13, FEED2-16, FEED2-17, FEED2-18, FEED2-24, FEED2-25, FEED-M2 | Reels and stories: honest delete and comment feedback; viewed stories marked; viewer closes at the end; confirm deletes; autoplay fallback; phone controls; expired stories removed live | 3 |
| **D-10** | FEED-M1, FEED2-14, FEED2-15, FEED2-26, FEED2-31 | Moderation queue grouped by item, with confirmations and messages; page governance UI (delete page, institutional flags, leave page); insights fixes; valid calendar files | 3 |
| **D-11** | FEED-P1, FEED-P2, FEED-P3, FEED-B14 | Feed performance: bounded queries for the home feed, no N+1 queries, missing indexes, no write on every feed load | 3 |

### 7.5 Meet journeys (workstream E)

| ID | Closes | Scope | Est. |
|---|---|---|---|
| **E-05** | MEET2-02, MEET2-03, MEET2-04, UX-1 | **Devices:** keep or reacquire camera and mic after a failed join; audio-only fallback with "try again"; unmuting gets a real mic; switch devices during a call | 3 |
| **E-06** | MEET2-05, MEET2-06, MEET2-07, MEET2-27, RT-5 | **Host experience:** "End for everyone" on phones with confirmation; alerts and lobby count in the mini-call; captions keep running when you leave the room page; warn before leaving a call; host handover | 3 |
| **E-07** | MEET-RT4, MEET-BUG8, MEET2-26, MEET2-28 | Connection recovery for the SFU transport; a reconnecting banner instead of an error page; switching meetings handled safely; one session across tabs | 3 |
| **E-08** | MEET2-09, MEET2-12, MEET2-13, MEET2-14, MEET2-15, MEET2-16, MEET2-34 | **Scheduling:** edit and reschedule meetings, manage invitees, RSVP; correct "coming up" order and calendar months; pasting a full link works; correct defaults and toggles; time-zone display | 4 |
| **E-09** | MEET-BUG3, MEET-BUG6 | Recordings saved safely when the host ends or leaves, uploaded in chunks; AI summary runs once per meeting | 4 |
| **E-10** | MEET-BUG4 | Breakout rooms finished end to end, or hidden until they are | 4 |
| **E-11** | MEET2-08, MEET2-10, MEET2-11, MEET2-17 to MEET2-25, MEET2-29 to MEET2-35, MEET-BUG7, MEET-BUG9 to BUG12 | Meet polish: route permissions match admission rules; correct states for ended or cancelled meetings; honest success messages; chat badge and private-chat fixes; summary and history accuracy; safe CSV export; share inside the room; guest reload; lobby wording; settings that actually apply | 5 |

### 7.6 Admin (workstream F)

| ID | Closes | Scope | Est. |
|---|---|---|---|
| **F-11** | ADMIN2-01, ADMIN2-02, ADMIN2-03, ADMIN2-08, ADMIN2-09, ADM-04 | Users screen: paging and totals, confirmation for role changes, safe dropdown when roles can't load, correct empty states, filters, sorting, export, labelled controls | 3 |
| **F-12** | ADMIN2-05, ADMIN2-06, ADMIN2-07 | Roles screen: warn about unsaved changes, detect concurrent edits, edit name and description, search permissions | 2 |
| **F-13** | ADM-01, ADMIN2-10, ADMIN2-11, ADMIN2-12 | Audit log: show what changed, readable targets, filters and paging, privileged events separated from routine ones, append-only storage with an index | 3 |
| **F-14** | ADMIN2-13 to ADMIN2-17 | Dashboard follows the app theme and pauses in hidden tabs; oversight error handling, paging, URL state and a required reason for opening; system status refreshes with timeouts | 3 |

**Phase 2 total:** about 130 developer-days (F 26.5 · B 22 · C 23 · D 20.5 · E 26 · Admin 11). At about 25 developer-days per week, that is **5 weeks** (17 Nov to 19 Dec). Anything still open on 19 Dec moves to January in the order listed. Workstream F is shared, so move tasks between workstreams as capacity allows.

---

## 8. Phase 3: Completeness (Jan to Feb 2027, backlog)

Sizes are t-shirt sizes (S, M, L, XL); refine them during grooming.

| ID | Closes | Item | Size |
|---|---|---|---|
| P3-01 | §10.5 i18n, FR-USR-8 | Translation framework and language switch (English, Kinyarwanda, French), with strings extracted from every module | XL |
| P3-02 | FILE-06, FR-FILE-* | Files module UI (or remove the tab until it exists); virus scanning; content-type checks; S3 driver | L |
| P3-03 | AUTH-01, X-07 (long term) | Session model: short-lived access token plus a refresh cookie, server-side logout, device list | L |
| P3-04 | §10.4, CHAT-L6, MAIL-M15 | Search: full-text plus fuzzy matching across modules, filters (from:, in:, has:), paging, recent searches | L |
| P3-05 | FR-MEET-4/17/18 | Meet: background blur, self-hosted captions, noise suppression | XL |
| P3-06 | FEED SRS gaps (§7.4 of the report) | Feed: class-level audiences, share to chat, @mentions resolved and notified, rich-text posts, hashtag filter, edit history view | L |
| P3-07 | FR-MAIL-11, MAIL-M8 | Inbound mail replies, asynchronous bounce feedback, unsubscribe headers | L |
| P3-08 | CHAT SRS gaps (§5.4 of the report) | Chat: math and code highlighting, custom emoji and skin tones, jump to date, extra slash commands, channel delete and restore, guest accounts, custom sections | L |
| P3-09 | CHAT-M7, CHAT-M8, MEET-RT3 | Scale: missing indexes, efficient read receipts, meeting room state shared across instances | M |
| P3-10 | §11 of the report | Accessibility pass: page headings, form labels, focus traps, keyboard access to reactions and menus, live regions, 24 px touch targets | M |
| P3-11 | ADM-03, OPS-04 | Retention policies, compliance export, feature flags; structured logs, metrics and error tracking | L |

---

## 9. Database migrations

| # | Task | Purpose | Prod notes |
|---|---|---|---|
| `0031` | A-01 | Partition maintenance function and default partitions | **Deploy by 24 Oct.** Read-only check first; safe to re-run |
| `0032` | C-03 | Private draft recipients; move existing draft and scheduled data | Back up first; staff notice; verify counts before and after |
| `0033` | B-02 | Thread read state; one-off recount of chat unread counters | Run off-peak; recount can take minutes on large channels |
| `0034` | C-07, C-09 | Per-thread mail folder and label state, count fixes | Backfill from existing rows |
| `0035` | A-07 | Upload quotas; file clean-up support | none |
| `0036` | E-03 | Attendance segments; unique participant per meeting and user | Backfill segments from existing joined/left times |
| `0037` | B-05 | Blocks and reports tables wired up (`user_blocks` exists; add reports) | none |
| `0038` | F-04 | Push subscriptions | none |
| `0039` | F-13 | Audit log index and append-only protection | Create the index concurrently |

**Rules:**
- Each migration is transactional and idempotent where possible.
- Seeds that touch role permissions are run **only** through the manual `seed` workflow input, never automatically, because seeding resets admin customisations.
- Every production migration is preceded by `pg_dump -Fc tupo_prod`.

---

## 10. Testing strategy and quality gates

| Layer | What | When |
|---|---|---|
| Unit (vitest) | Service rules: guards, validation, counters, unread maths, sanitiser | Every PR (CI) |
| API integration (`apps/api/src/__tests__`) | Route behaviour, permissions, regression cases for each finding | Every PR (CI) |
| Live suites (`verify:*`) | Existing suites, plus these promoted ones: `verify:security`, `verify:realtime`, `verify:chat:unread`, `verify:chat:journeys`, `verify:mail:journeys`, `verify:feed:journeys`, `verify:shell` | Nightly on staging; before each release |
| UI sweeps | Responsive and accessibility sweep from `gap-ui-probe.mjs` (13 pages × 3 viewports) | Weekly, and before each release |
| Manual exploratory | Phones (Android Chrome, iOS Safari), installed PWA, slow 3G, two devices per user | Each phase exit |

**Quality gates:**
1. CI must pass to merge (G-01).
2. No release while a Critical or High regression check is red.
3. Each phase exit has a QA sign-off with probe outputs attached to the release ticket.
4. Probe clean-up must leave zero test users, pages or files behind (G-04).

---

## 11. Release and rollout

- **Cadence:** weekly releases on Tuesdays; hotfixes as needed for Phase 0.
- **Order inside a release:** migrations, then API and worker, then realtime, then files, then the web build. The realtime gateway is reloaded last among the services, so new events are understood on both sides.
- **Feature flags** (environment variables) for behaviour changes that users will notice: the new unread model (B-02), security headers in report-only vs enforce mode (C-02), web push (F-04) and rate-limit thresholds (A-05). They allow a fast rollback without a redeploy.
- **Production checks after each release:**
  - `npm run health`;
  - partition months-ahead metric;
  - error-log scan;
  - the smoke subset of `verify:*` run on the box.
- **Communication:** short release notes for staff when behaviour changes (mail drafts, unread badges, new notification centre).

---

## 12. Risks and mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Partition work slips past 1 Nov | Low | Outage of chat and meetings | A-01 is first, with a 24 Oct deadline; default partitions as a safety net; monitoring alert |
| Sanitiser strips legitimate mail formatting | Medium | User complaints | Allowlist built from the editor's output; backfill dry run with a diff; report-only headers first |
| Unread recount surprises users (badges change overnight) | Medium | Confusion | Release note; run off-peak; flag to roll back |
| Rate limits block legitimate bursts (teachers posting to many classes) | Medium | Friction | Generous starting thresholds; per-role overrides; monitoring of 429 responses |
| Broadcast payload change breaks older open tabs | Medium | Stale UI until reload | Clients tolerate both payload shapes for one release; the PWA update prompt (F-09) |
| Team capacity lower than assumed | Medium | Phase 2 slips | Strict priority order; Phase 2 tasks are independent and can move to January |
| Single-instance production makes every release a short outage | High | Brief downtime | Deploy off-peak; Phase 3 adds a second instance |

---

## 13. Tracking

- Create one tracker issue per task ID (A-01 … F-14, P3-xx), labelled with the workstream, the phase and the finding IDs it closes.
- Keep a findings register, either a spreadsheet or a GitHub project, with columns **Finding ID · Severity · Task ID · Status · PR · Verified by**. Seed it from the report's tables.
- Report weekly: findings closed by severity, probes green or red, and phase burn-down.
- At the end of Phase 2, re-run every probe and the full gap analysis, and publish a short "remaining gaps" addendum.

### Finding-to-task map (Critical and High)

| Findings | Task |
|---|---|
| X-01, MEET-BUG5 | A-01 |
| X-02, X-03, X-04, MEET-SEC2, MEET-SEC7 | A-02 |
| X-05 | A-03, A-05 |
| X-06, FEED-R1 to R3 | X-01 |
| X-07 | C-02, P3-03 |
| MAIL-C1 | C-01 |
| MAIL-C2, MAIL-H8 | C-02 |
| MAIL-C3, MAIL-H1, MAIL-H3 | C-03 |
| MAIL-H2 | C-04 |
| MAIL-H4, H5, H6 | C-06 |
| MAIL-H7, MAIL2-01 | C-05 |
| MAIL-H9, MAIL-H10 | C-07, F-03 |
| MAIL2-02, MAIL2-03 | C-08, C-09 |
| FEED-S2, FEED-A1, FEED2-01 | D-01 |
| FEED-S1, FEED-A2 | D-02 |
| FEED-F1 | D-05 |
| FEED-B1 | D-07 |
| FEED-L1 | D-04 |
| FEED2-02, FEED2-03 | D-06 |
| CHAT-C1, CHAT-C2 | B-01 |
| CHAT-H1, H9, H12 | B-03 |
| CHAT-H2 | X-02 |
| CHAT-H3, H4, H5 | B-04 |
| CHAT-H6 | B-08 |
| CHAT-H7 | B-11 |
| CHAT-H8, CHAT-U1 to U3, CHAT-U5 | B-02, F-03 |
| CHAT-H10 | B-10 |
| CHAT-H11 | B-05 |
| CHAT2-01 | A-08 |
| CHAT2-02, CHAT2-03 | F-05 |
| CHAT2-04, CHAT2-05 | B-06 |
| CHAT2-06, CHAT2-07 | B-07 |
| MEET-SEC1, SEC3 | X-02 |
| MEET-SEC4 | E-02 |
| MEET-SEC5, SEC6 | E-01 |
| MEET-RT1, MEET-BUG1 | E-03 |
| MEET-RT2 | E-04 |
| MEET-RT4 | E-07 |
| MEET-BUG3 | E-09 |
| MEET-BUG4 | E-10 |
| MEET2-01 to MEET2-09 | E-05, E-06, E-08, E-11 |
| NOTIF-01 to NOTIF-04 | F-01, F-02, F-04, F-05 |
| FILE-01, FILE-02 | A-06, A-07 |
| FILE-06 | P3-02 |
| AUTH-01 | P3-03 |
| SHELL2-01, SHELL2-02 | F-06, A-11 |
| ADMIN2-01 to ADMIN2-04 | F-11, A-10 |
| OPS-01, OPS-02 | G-01, G-02 |

---

## 14. Immediate next steps (this week)

1. **Today:** run the production partition check (A-01, step 1) and share the result.
2. **Product owner:** decide the thread-unread rule for B-02 (recommended: thread replies don't count unless also sent to the channel).
3. **Leads:** assign named owners to workstreams A to G and create the tracker issues for Phase 0.
4. **QA:** set up the staging run of the existing `verify:*` suites and the `gap-*` probes as the baseline.
5. **Kick-off on Tuesday 13 Oct:** walk through Phase 0, agree estimates, start A-01, A-02 and G-01 first.
