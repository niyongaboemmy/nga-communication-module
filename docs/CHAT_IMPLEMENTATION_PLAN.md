# Tupo Chat — Implementation Plan

**Scope:** turn the Phase 0 chat *prototype* (three panes rendering
`placeholderData.ts`) into a real, production-grade messaging product with a
Slack-class channel model and a WhatsApp-class conversation experience.

**Status of the ground being built on** — verified against the running stack on
21 August 2026:

| Already exists | Where |
|---|---|
| `conversations`, `conversation_members` (`last_read_seq`, `unread_count`, `notification`) | `packages/db/migrations/0001_init.sql` |
| `messages`, monthly-partitioned, with a `(conversation_id, sender_id, nonce)` unique index | same |
| Snowflake IDs, migration runner | `packages/db/src/` |
| Socket.IO gateway, JWT handshake, Redis adapter, per-user rooms, presence keys | `apps/realtime/src/index.ts` |
| Generic `notifications` table + `notifyAndPush()` over a Redis channel | `0009_notifications.sql`, `apps/api/src/services/notificationService.ts` |
| File upload/download with streaming checksum, pluggable storage driver | `apps/files/` |
| 60-permission RBAC, messaging permissions already catalogued | `packages/shared/src/permissions.ts` |
| Three-pane responsive chat UI, skeletons, dark mode, permission gating | `apps/web/src/pages/chat/` |

| Does **not** exist yet |
|---|
| Any `/api/conversations` or `/api/messages` route |
| Any chat socket event beyond `ping`/`presence` |
| Reactions, threads, pins, saves, receipts, typing, drafts, mentions, search, polls |
| Attachments in messages; the file service is still **owner-only** on download |
| Chat notifications of any kind |
| Everything in the UI below the layout: every interaction is currently inert |

---

## 1. Reference research — what Slack and WhatsApp actually do

Both were studied for *mechanism*, not just feature names. The behaviours below
are the ones that make each product feel the way it does, and each is traced to
a requirement in this plan.

### 1.1 Slack — the channel model

| Behaviour | Why it matters | Where implemented |
|---|---|---|
| **Monotonic per-conversation sequence**, not timestamps, as the ordering key | Two messages in the same millisecond still have a total order; the unread watermark is a single integer comparison rather than a date range | P1 — `messages.seq`, `conversations.last_seq` |
| **`last_read_seq` watermark**, not per-message read flags | Marking 400 messages read is one `UPDATE`, and unread count is arithmetic | P1 |
| **Threads are a second axis**, not nested messages | A busy channel stays readable; replies do not flood the main list unless "also send to channel" | P3 — `messages.thread_root_id` |
| **Client-generated nonce** on send | A retry after a dropped ack cannot double-post | P1 — existing unique index |
| **Optimistic local echo** reconciled by nonce | Send feels instant on a 400 ms link | P1 |
| **`@here` vs `@channel`** distinction | `@here` respects who is actually around; `@channel` is the loud one and is permissioned | P5 |
| **Per-conversation notification level** overriding a global default | The single biggest reason people do not mute the whole app | P5 |
| **Unfurls, pins, saved items, reminders** | Turn a chat log into a working surface | P3, P6 |
| **Keyboard-first**: ⌘K, ⌘⇧K, ↑ to edit, Esc to mark read | Power users never touch the mouse | P6 |

### 1.2 WhatsApp — the conversation model

| Behaviour | Why it matters | Where implemented |
|---|---|---|
| **Three delivery states** with the ✓ / ✓✓ / blue ✓✓ vocabulary | The sender knows where a message stopped, which is what makes people trust it | P2 — `message_receipts` |
| **Read receipts are reciprocal** — opting out of sending also opts out of seeing | The only version of the setting that is not a one-way mirror | P2 |
| **Reply-quote block** rendered inline above the message, tappable to jump | Keeps context without threads | P3 |
| **Message grouping by author + time window** | The log reads as conversation, not as a table | ✅ already in `data.ts` |
| **Typing indicators expire on silence**, not only on send | No ghost "typing…" left behind by a closed tab | P2 — 6 s TTL |
| **Voice notes** with waveform + variable-speed playback | The fastest input method on a phone | P4 |
| **Media-first attachments**: inline image grid, lightbox, download | An image is content, not a file row | P4 |
| **Offline queue** with `pending` state, flushed in order | A school on a flaky link still works | P2 |
| **Disappearing messages** per conversation | Data-minimisation for a safeguarding context | P7 |
| **Forward with attribution**, star/save, chat search | Everyday verbs | P3, P6 |

### 1.3 Deliberate divergences for a school

| Decision | Reason |
|---|---|
| No end-to-end encryption | Safeguarding and compliance require server-side moderation, retention and legal export (SRS §12.5). Transport TLS + at-rest encryption instead. |
| DM initiation is policy-gated, not universal | `DM_START` is withheld from students by default (SRS FR-USR-6). Enforced at the API. |
| `@channel` is a permission, not a courtesy | A 500-member class channel is not a place for an accidental all-ping. |
| Announcement channels are read-only by default | Mirrors how schools actually broadcast. |
| Every moderator deletion is audit-logged | Non-negotiable in a child-safety context. |

---

## 2. Complete feature register

Each row is a deliverable, traced to its SRS requirement and its phase.
`M` = must, `S` = should, `C` = could.

### 2.1 Conversations, channels, membership

| # | Feature | Pri | SRS | Phase |
|---|---|---|---|---|
| C-1 | Public / private / announcement channels, group DMs, 1:1 DMs | M | FR-CHN-2 | P1 |
| C-2 | Create channel (name, topic, purpose, privacy, colour) | M | FR-CHN-3 | P7 |
| C-3 | Open-or-create a DM by user id, idempotent (one DM per pair) | M | FR-CHN-2 | P1 |
| C-4 | Group DM from a multi-select of people | M | FR-CHN-2 | P7 |
| C-5 | Browse & join public channels (directory with search) | M | FR-CHN-6 | P7 |
| C-6 | Invite / remove members; leave; transfer ownership | M | FR-CHN-6 | P7 |
| C-7 | Channel roles: owner · admin · moderator · member | M | FR-CHN-4 | P1 (model) / P7 (UI) |
| C-8 | Archive / restore a channel (read-only, still searchable) | M | FR-CHN-7 | P7 |
| C-9 | Star (favourite) a conversation; sidebar section | M | FR-CHN-10 | P1 |
| C-10 | Mute; per-conversation notification level all · mentions · none | M | FR-CHN-9 | P5 |
| C-11 | Sidebar sections + filters (unread · DMs · channels · mentions) | S | FR-CHN-10 | P1/P7 |
| C-12 | Contact-policy enforcement on DM creation | M | FR-USR-6 | P1 |
| C-13 | Invite by link with expiry and use-limit | S | FR-CHN-6 | P7 |
| C-14 | Sidebar drag-to-reorder / custom sections | C | FR-CHN-10 | P7 |

### 2.2 Messaging core

| # | Feature | Pri | SRS | Phase |
|---|---|---|---|---|
| M-1 | Send / receive text, sub-500 ms p95 | M | FR-MSG-1 | P1 |
| M-2 | Idempotent send by nonce | M | FR-MSG-23 | P1 |
| M-3 | Optimistic local echo, reconciled on ack | M | UX-1 | P1 |
| M-4 | Cursor pagination, infinite scroll upward | M | FR-MSG-16 | P1 |
| M-5 | Unread watermark, unread + mention counts, "new messages" divider | M | FR-MSG-15 | P1 |
| M-6 | Rich text: bold, italic, strike, code, code blocks, quote, lists, links | M | FR-MSG-3 | P2 |
| M-7 | Emoji reactions, counts, reactor list, picker | M | FR-MSG-5 | P2 |
| M-8 | Edit own message within window; version history; "edited" marker | M | FR-MSG-8 | P2 |
| M-9 | Delete own (tombstone); moderator delete-any, audit-logged | M | FR-MSG-9 | P2 |
| M-10 | Typing indicators, 3 s throttle / 6 s expiry | M | FR-MSG-14 | P2 |
| M-11 | Delivery states sent → delivered → read, ✓/✓✓ UI | M | FR-MSG-13 | P2 |
| M-12 | Read-receipt opt-out, reciprocal | M | FR-MSG-13 | P2 |
| M-13 | Threaded replies + "also send to channel" + auto-follow | M | FR-MSG-6 | P3 |
| M-14 | Quote-reply with jump-to-original | M | FR-MSG-7 | P3 |
| M-15 | Forward to one or many conversations, retaining attribution | M | FR-MSG-10 | P3 |
| M-16 | Pin / unpin; pinned list in the header | M | FR-MSG-11 | P3 |
| M-17 | Save / bookmark to a personal "Saved items" list | M | FR-MSG-12 | P3 |
| M-18 | Permalink, jump-to-message, jump-to-date | M | FR-MSG-16 | P3 |
| M-19 | Drafts persisted per conversation, cross-device | M | FR-MSG-17 | P6 |
| M-20 | Scheduled send + pending queue management | S | FR-MSG-18 | P6 |
| M-21 | Polls: single/multi, anonymous, live bars, close time | M | FR-MSG-21 | P6 |
| M-22 | Slash commands `/meet /poll /remind /away /invite /archive /shrug` | S | FR-MSG-26 | P6 |
| M-23 | Link unfurling, SSRF-guarded | S | FR-MSG-22 | P6 |
| M-24 | Offline queue in IndexedDB, flushed in order | M | FR-MSG-24 | P2 |
| M-25 | Disappearing messages 24 h / 7 d / 90 d | S | FR-MSG-19 | P7 |
| M-26 | Inline translation EN ⇄ RW ⇄ FR | C | FR-MSG-25 | P7 |
| M-27 | System messages (joined, left, topic changed, pinned) | M | FR-MSG-2 | P1 |

### 2.3 Mentions, search, notifications

| # | Feature | Pri | SRS | Phase |
|---|---|---|---|---|
| N-1 | `@user` autocomplete with keyboard nav | M | FR-MSG-4 | P5 |
| N-2 | `@channel` / `@here`, permission-gated | M | FR-MSG-4 | P5 |
| N-3 | Mention rows in `message_mentions`, mention unread count | M | FR-MSG-15 | P5 |
| N-4 | Notification on: DM, mention, channel message (per level), thread reply, reaction to my message | M | FR-NOTIF | P5 |
| N-5 | Browser Web Notifications with permission prompt + click-to-open | M | FR-NOTIF | P5 |
| N-6 | Sound, respecting DND and mute | M | FR-NOTIF | P5 |
| N-7 | Favicon / document-title unread badge | S | FR-NOTIF | P5 |
| N-8 | Per-conversation + global notification preferences UI | M | FR-USR-8 | P5 |
| N-9 | Do-not-disturb schedule (quiet hours) | S | FR-NOTIF | P5 |
| N-10 | Message search: full-text, filters by person/channel/date/has-file | M | FR-SRCH | P6 |
| N-11 | Command palette ⌘K across conversations, people, messages | M | UX | P6 |

### 2.4 Files & media

| # | Feature | Pri | SRS | Phase |
|---|---|---|---|---|
| F-1 | Attach files to a message (multi), progress bar, cancel | M | FR-FILE-1 | P4 |
| F-2 | Drag-and-drop onto the thread; paste image from clipboard | M | UX | P4 |
| F-3 | **Conversation-scoped download ACL** (today: owner-only — a real bug) | M | FR-FILE-3 | P4 |
| F-4 | Inline image/video rendering + lightbox gallery with keyboard nav | M | UX | P4 |
| F-5 | Download single file; download-all for a message | M | FR-FILE-3 | P4 |
| F-6 | Files tab in the context panel, per conversation, filterable | M | FR-FILE-2 | P4 |
| F-7 | Voice notes: record, waveform, playback speed | M | FR-MSG-20 | P4 |
| F-8 | Thumbnails / previews for images and PDFs | S | FR-FILE-5 | P4 |
| F-9 | Size limits, type policy, friendly errors | M | FR-FILE-4 | P4 |

### 2.5 Presence, profiles, UX

| # | Feature | Pri | Phase |
|---|---|---|---|
| U-1 | Live presence in list, header and member list | M | P2 |
| U-2 | Custom status with emoji + expiry | S | P7 |
| U-3 | Profile card popover from any avatar | M | P7 |
| U-4 | Keyboard shortcuts + a shortcuts sheet | M | P6 |
| U-5 | Emoji picker with search, skin tone, frequently-used | M | P2 |
| U-6 | Virtualised message list for 10k-message channels | S | P7 |
| U-7 | Full responsive pass: 320 px → ultrawide, iOS keyboard, safe areas | M | every phase |
| U-8 | Motion: message-in, reaction pop, panel slide — all `prefers-reduced-motion` aware | M | P2 |
| U-9 | a11y: roles, live regions, focus traps, visible focus, contrast | M | every phase |
| U-10 | Connection state banner: reconnecting / offline / degraded | M | P2 |

---

## 3. Phase plan

Each phase ends with a **gate**: `npm run typecheck` clean, `npm run build`
clean, its own `scripts/verify-chat-*.mjs` green against the running stack, and
a Playwright UI pass where the phase has visible surface. Nothing starts until
the previous gate is green.

| Phase | Delivers | Gate script |
|---|---|---|
| **P1 — Spine** | Migration `0010_chat`; conversations + messages REST; socket rooms and `message:new`; real send with nonce + optimistic echo; pagination; unread watermark; star; system messages; UI cut over from placeholders to live data | `verify-chat-core.mjs` |
| **P2 — Live** | Reactions, edit, delete, typing, receipts (✓/✓✓), presence, rich text, emoji picker, offline queue, connection banner, motion | `verify-chat-live.mjs` |
| **P3 — Structure** | Threads, quote-reply, forward, pin, save, permalink/jump-to-message | `verify-chat-threads.mjs` |
| **P4 — Media** | Attachments end-to-end, conversation ACL, lightbox, files tab, voice notes, drag-drop/paste | `verify-chat-files.mjs` |
| **P5 — Notifications** | Mentions, notification fan-out rules, per-conversation prefs, web notifications, sound, badges, quiet hours | `verify-chat-notifications.mjs` |
| **P6 — Power** | Search, ⌘K palette, drafts, scheduled send, polls, slash commands, shortcuts, unfurls | `verify-chat-power.mjs` |
| **P7 — Management** | Channel create/browse/join/invite/archive, member management, profile cards, custom status, disappearing messages, virtualisation, a11y + responsive audit | `verify-chat-admin.mjs` |

---

## 4. Data model additions (migration `0010_chat.sql`)

Extends, never rewrites, the Phase 0 tables.

```
messages          + thread_root_id, reply_to_id, reply_count, thread_last_at,
                    pinned_at, pinned_by, edited_count, attachments jsonb,
                    metadata jsonb
conversations     + description, avatar_color, icon_emoji, retention_days,
                    last_message_at, last_message_preview
conversation_members
                  + is_starred, unread_mentions, muted_until, last_read_at,
                    draft, draft_updated_at

message_reactions      (conversation_id, message_id, user_id, emoji)   PK
message_receipts       (conversation_id, message_id, user_id, state, at)
message_mentions       (conversation_id, message_id, user_id, kind)
message_saves          (user_id, message_id, conversation_id, saved_at)
message_edits          (id, message_id, body, edited_at, editor_id)
message_attachments    (message_id, file_id, ordinal, kind, meta)
scheduled_messages     (id, conversation_id, sender_id, body, send_at, state)
polls / poll_votes
conversation_invites   (id, conversation_id, code, expires_at, max_uses, uses)
contact_policies       (id, space_id, from_role, to_role, allow)
user_chat_prefs        (user_id, read_receipts, enter_to_send, quiet_from/to,
                        sound, desktop_notifications, default_level)
```

Indexes that matter: `messages(conversation_id, seq DESC)` for scrollback,
`messages(thread_root_id, created_at)` for a thread, a GIN full-text index on
`body` for search, and `message_receipts(user_id, state)` for the read sweep.

**Sequence allocation.** `conversations.last_seq` is bumped with
`UPDATE … SET last_seq = last_seq + 1 RETURNING last_seq` inside the same
transaction as the insert. The row lock serialises concurrent senders, which is
exactly the guarantee a per-conversation total order needs.

---

## 5. Socket protocol additions (`packages/shared/src/chatEvents.ts`)

```
client → server   conversation:subscribe / :unsubscribe
                  message:send · :edit · :delete · :react · :unreact
                  typing:start · typing:stop
                  read:advance   { conversationId, seq }
server → client   message:new · :updated · :deleted · :reaction
                  typing:update · read:update · receipt:update
                  conversation:updated · :member_changed · :unread
                  thread:reply
```

Rooms: `conv:<id>` for conversation traffic, the existing `user:<id>` for
notifications and cross-device state. Membership is checked **on subscribe**
against the database — never taken from the client — and re-checked on the write
path, because a socket that stays open across a removal must not keep receiving.

---

## 6. Risks

| Risk | Mitigation |
|---|---|
| Sequence contention on a hot channel | Row lock is held for microseconds; measured under a 50-sender burst in the P1 gate |
| Notification noise driving mass mutes | Rules in P5 are explicit and tested: never notify your own action, mentions bypass "mentions-only" but never DND, one notification per thread per burst window |
| File ACL currently owner-only | Fixed in P4 with a conversation-membership check; a test asserts a non-member gets 403 |
| Partition boundary at month end | Worker job pre-creates the next partition; asserted by a test that inserts across a boundary |
| Payload growth on the message wire | Attachments and reactions are denormalised onto the message row for read; the join tables stay authoritative for write |
| Scope | Strict phase gates; each phase is independently shippable |

---

## 7. Definition of done

All 7 phase gates green; `npm run typecheck` and `npm run build` clean across
all 7 workspaces; `npm audit` at zero; every feature in §2 marked `M` implemented
and covered by either an automated gate check or a documented UI pass.

---

## 8. Phase 1 — delivered

**Gate: 51/51 API checks, 17/17 browser checks, 8/8 workspaces typecheck and build.**

```
npm run verify:chat        # scripts/verify-chat-core.mjs  — 51 checks
npm run verify:chat:ui     # scripts/verify-chat-ui.mjs    — 17 checks, two real browsers
```

### What was built

| Layer | Added |
|---|---|
| Schema | `0010_chat.sql` — 13 tables, thread/pin/attachment/expiry columns, FTS and scrollback indexes; `0011_message_nonces.sql` |
| Domain | **`packages/chat`** — a new workspace package holding the whole chat domain |
| API | `apps/api/src/routes/chat.ts` — conversations, messages, read, prefs, drafts, members, directory |
| Bridge | `apps/api/src/services/chatRealtime.ts` — API → gateway over one Redis channel |
| Gateway | `apps/realtime/src/chat/handlers.ts` — rooms, send, typing, read, receipts |
| Contract | `packages/shared/src/chat.ts`, `chatEvents.ts` |
| Web | `ChatProvider` store, `lib/socket.ts`, live `ConversationList` / `MessageThread` / `Composer` / `ContextPanel`, `NewConversationDialog` |

`placeholderData.ts` is deleted. Nothing in chat renders fake content any more.

### Why the domain became a package

`message:send` is handled on the socket, because the connection is already open
and the round trip is the one users can feel. But the REST route must accept the
same send — it is what the offline queue flushes through. Two implementations of
"send a message" means two implementations of its authorisation, and the copy
that drifts is always the one with the hole in it. `@tupo/chat` is imported by
both processes so there is exactly one.

### Five real defects found by the gates

These are recorded because each was invisible in review and each would have
reached production.

| Defect | Symptom | Cause | Fix |
|---|---|---|---|
| **Connection-pool deadlock** | The entire API wedged permanently under 25 concurrent sends — every later request including `/health` hung forever | `sendMessage` called `getMessage()` (which takes its own pool connection) while still holding the transaction's client. At `max: 10` concurrent sends, all ten held a connection and waited for an eleventh | Split into `writeMessage` (transactional, returns an id) and a read-back **after** the client is released. Nothing may acquire a second connection while holding one |
| **Idempotency was never enforced** | A retried send would silently double-post | `messages` is partitioned, so its unique index must contain `created_at` — a retry one millisecond later does not collide. The index forbade only the one case a retry never produces | `message_nonces`, a small unpartitioned claim table. Proven by the gate |
| **Silent no-op from two data-modifying CTEs** | Marking a conversation read returned "conversation not found" for a conversation the user was plainly in | `advanceRead` bumped the watermark in one CTE and recounted in a second; both see the pre-statement snapshot, and PostgreSQL will not let the second update a row the first touched. Zero rows, no error | Rewritten as one `UPDATE` with the watermark computed once in a `prev` CTE |
| **Typing indicator inverted** | The one person who needed to see "Ada is typing" was the only one told nobody was | `broadcastTyping` filtered `user.id` out of the payload — but the closure belongs to one socket, so it removed that person from *everyone's* copy | Broadcast the whole set; each client drops its own id |
| **Incoming DMs opened themselves** | A message arriving while you were elsewhere yanked you into it and marked it read | The auto-open effect re-fired whenever the list became non-empty, not just on first load | Latch set when the initial load completes, even if it completed empty |

Two smaller ones: a system notice ("created this channel") was badging people —
excluded from unread on both the send path and the recount, or the two disagree;
and a newly created DM never reached the recipient's sidebar, because the direct
route emitted nothing and the client dropped unread events for conversations it
did not know. Conversations are now announced **per viewer** (a DM summary is
viewer-scoped — one payload to the room would show Ada her own name), and the
client refetches when told about something unfamiliar.

### Also fixed along the way

The gate script buffered all output to the end, so its first hang produced an
empty file and no clue. It now streams every check as it runs.

---

## 9. Phase 2 — delivered

**Gate: 43/43 live checks, 51/51 Phase 1 checks (no regression), 32/32 browser
checks, 9/9 workspaces typecheck and build, `npm audit` 0.**

```
npm run verify:chat        # 51 — the spine
npm run verify:chat:live   # 43 — reactions, edits, deletions, notifications, presence, receipts
npm run verify:chat:ui     # 32 — two real browsers, desktop + phone
```

### What was built

| Area | Delivered |
|---|---|
| Reactions | Toggle semantics, per-emoji grouping, `mine` resolved per viewer, reactor names, live over the socket, one-tap quick reactions plus a picker |
| Editing | Author-only, 24 h window, previous version archived to `message_edits`, mentions recomputed, sidebar preview follows the edit, in-place editor |
| Deleting | Tombstone that keeps its `seq`, body and attachments stripped on the wire, moderator delete-any audit-logged, unread arithmetic recomputed, inline confirm |
| Notifications | **`packages/notify`** extracted; `packages/chat/src/notifications.ts` holds the audience rules |
| Presence | Broadcast to DM counterparts only, on connect, change and last-disconnect |
| Receipts | `delivered` / `read` rows, reciprocal opt-out |
| Rich text | Bold, italic, strike, inline code, fenced blocks, quotes, lists, links, mentions — tokenised into React elements, never HTML |
| Emoji | Hand-rolled picker, keyword search, frequently-used, caret-aware insertion |
| Offline | IndexedDB outbox, durable-before-optimistic, in-order flush, give-up after 5 attempts |

### The notification rules

Written down because this is the file that decides whether people leave
notifications switched on, and every rule is there because its absence is a
reason to mute the app:

- Never notify anyone about their own action.
- A DM always notifies — there is no reading of "all / mentions / none" under
  which someone writing to you personally should be silent.
- A channel message notifies only at level `all`.
- A mention pierces `mentions`; it does **not** pierce `none`. Choosing
  "nothing" has to mean nothing or the setting is a lie.
- `@channel` / `@here` are not personal mentions. They reach `all`, and reach
  `mentions` only if the sender holds `CHANNEL_ANNOUNCE` — otherwise one person
  typing `@here` turns every muted channel back on for four hundred people.
- A burst of fifteen messages refreshes one row rather than stacking fifteen.
  The badge carries the count; the notification carries the fact.
- `mutedUntil` wins over everything. "Mute for an hour" means an hour.

Quiet hours and sound are applied client-side in Phase 5: the row should exist
either way, so it is waiting in the morning. What gets suppressed is the
interruption, not the record.

### Why `packages/notify` exists now

`notifyNewMessage` has to run on whichever path actually sent the message, and
the normal path is the socket — so the realtime gateway needs it. The store
lived in `apps/api/src/services/notificationService.ts` and Meet already used
it. It moved to a package and `apps/api` imports it from there; Meet's call
sites changed by one import line and nothing else.

### Defects found this phase

| Defect | Where |
|---|---|
| The edit textarea and the button that opens it shared the accessible name "Edit message" — a screen-reader user hears the same label twice with no way to tell them apart | Renamed the field to "Edit message text" |
| The message transcript had no role of its own, so arriving messages were not announced and the pane could not be addressed independently | `role="log"` with `aria-relevant="additions"` — the correct role for a chat transcript, carrying an implicit polite live region |

Both were surfaced by writing the browser assertions against **accessible
names** rather than CSS selectors. A test that can only find an element by its
class cannot tell you the element is unusable.

### A test bug worth recording

Four checks reported edit and delete as broken while the screenshot plainly
showed both working. The cause was `locator.isVisible({ timeout })` — that
method samples the DOM **once** and returns immediately; its `timeout` bounds
resolving the selector, not waiting for the element. Every assertion following
a network round trip was reading the page before the response arrived. Replaced
with a `visible()` helper built on `waitFor`, and the false failures went away.

The lesson generalises: an assertion that cannot wait will fail intermittently
under load and be blamed on the feature.

---

## 10. Phase 3 — delivered

**Gate: 35/35 structure checks, 47/47 browser checks, and 51/51 + 43/43 on the
earlier phases with no regression. 9/9 workspaces typecheck and build.**

```
npm run verify:chat:threads   # 35 — threads, quotes, pins, saves, forwarding, permalinks
npm run verify:chat:ui        # 47 — two real browsers
```

### What was built

| Area | Delivered |
|---|---|
| Threads | Second-axis replies excluded from the main flow, one level deep, "also send to channel", participants auto-followed, dedicated pane repeating the root |
| Quote reply | Denormalised quote block, tap-to-jump, survives deletion of the quoted message as a marked tombstone |
| Pins | Per-conversation pinned list capped at 50, collapsible bar above the log, announced in the room |
| Saved items | Personal cross-conversation list, membership re-checked on read, own pane |
| Forwarding | Multi-target with per-target authorisation, attribution carried on the row, optional note |
| Permalinks | `…/messages/:id/context` returns a window centred on the message; `jumpTo` reuses the loaded log when it can and flashes the target |

### Decisions worth recording

**Threads are one level deep.** Replying to a reply joins the same thread rather
than nesting. Every product that has shipped threads landed here, because the
second level is unreadable in a 400px column and the tree quickly stops
describing the conversation.

**Participation is the thread subscription.** A "follow" button people cannot
see means threads notify nobody; notifying the whole channel means a thread is
no quieter than the room, which is the one thing it exists to be. Whoever has
written in it is the honest middle, and it is asserted both ways in the gate.

**A forward out of a DM does not name the DM.** Attribution says who wrote it;
disclosing *where* would leak who is talking to whom into a channel. Tested.

**"Also send to channel" writes a second message** rather than moving the reply
out of the thread, so the thread still reads as a thread afterwards.

### Defects found this phase

| Defect | Cause | Fix |
|---|---|---|
| **System notices were written but never broadcast** — "pinned a message" appeared only after a reload, which is exactly when it has stopped being useful | `chat.systemMessage` writes the row; each caller had to remember to emit, and the pin route did not | An `announce()` helper that writes *and* emits, so there is no longer a step to forget |
| The hover toolbar for your own message rendered at the far **left** of a full-width row, half a screen from the bubble it acted on | `left-12` for `mine`, in a `flex-row-reverse` row | Anchored to the side the bubble is on: `right-14` / `left-14` |
| `listSaved` was built by string-patching the shared `MESSAGE_SELECT` fragment — it compiled, ran, and would have broken silently at the next column rename | Convenience | Written out explicitly; the duplication is cheaper than the trap |

One gate assertion was also wrong rather than the code: "pinning is permissioned"
tested a Staff account, and Staff legitimately holds `MESSAGE_PIN`. Re-pointed at
a Student, which is the role that does not, plus a follow-up asserting the
refused action had no effect.

### A note on the browser gate

`getByRole(role, { name })` matches the accessible name as a **substring** by
default, so `'Saved items'` also matched `'Remove from saved items'` on a
message row. Passing `exact: true` where a name is a prefix of another is not
optional.

---

## 11. Phase 4 — delivered

**Gate: 42/42 file checks, 60/60 browser checks, and 51 + 43 + 35 on the earlier
phases with no regression. 9/9 workspaces typecheck and build, `npm audit` 0.**

```
npm run verify:chat:files   # 42 — upload, access control, tickets, serving rules
npm run verify:chat:ui      # 60 — two real browsers
```

### The bug this phase existed to fix

Phase 0 shipped the download route as `owner_id = caller`, with a comment saying
conversation-scoped ACLs would arrive later. That is not a missing feature, it
is a broken one: the moment a file is attached to a message, every recipient
needs to read it and **none of them owns it**. An attachment readable only by
the person who sent it is not an attachment.

The rule now, in `apps/files/src/access.ts`, checked on every request:

| Who | May read |
|---|---|
| The uploader | Always — including before it is attached, which is what makes the ticket → bytes → send pipeline work |
| A **live** member of a conversation it is attached to | Yes. Attachment is the grant; membership is the check |
| Anyone else | No — 404, not 403, because confirming a file id exists is itself a disclosure |

Access is *live*, and the gate proves each direction: leaving the conversation
revokes it, rejoining restores it, and deleting the message that carried the
file revokes it for recipients while leaving the uploader their own copy.

### Media tickets, and why they are not signed URLs

An `<img>`, `<video>` or `<audio>` cannot send an Authorization header. Fetching
every image to a blob would work for pictures but destroys range requests, so a
40 MB lesson recording would have to download in full before playing a second.

So: a 60-second JWT bound to one file and one person, passed as `?t=`.

The distinction that matters — a signed URL **is** the authorisation, and anyone
holding it gets the bytes for as long as it lives. This ticket carries only an
*identity*; `canReadFile` still runs on redemption against live membership. The
gate asserts both consequences: a ticket stops working the instant its holder
loses access, and a ticket minted for one file cannot be replayed against
another.

### Also delivered

| Area | Delivered |
|---|---|
| Upload | Ticket → XHR with real progress → attach. Starts on choose, not on send; cancel aborts the request rather than ignoring it |
| Input | File picker, drag-and-drop with a drop overlay, and clipboard paste (screenshots are the commonest attachment there is) |
| Rendering | Images and video tiled inline with the box reserved from the sender's measured dimensions, lightbox with keyboard nav, documents as rows with a download button |
| Voice notes | Live analyser meter while recording, waveform computed once at record time, playback with scrub and 1×/1.5×/2× |
| Files tab | Per-conversation, filterable, each entry jumping back to the message it came from |
| Serving | `attachment` by default (uploaded HTML is never inline, whatever is asked for), `nosniff`, `private` caching, HTTP 206 range support |
| Refusals | Size, empty files, and executables — refused at choose time, with the reason stated next to the composer |

### Defects found this phase

| Defect | Cause | Fix |
|---|---|---|
| **A rejected `.exe` produced no message at all** | `add()` called `setErrors` from *inside* a `setUploads` updater. React runs updaters during the render phase, so that is a state update during another component's render — unsupported, and silently dropped | Validation and slot accounting moved out of the updater, with a ref mirroring the tray so two drops in one tick cannot both think it is empty |
| **The `/metadata` route was never registered** | A `str.replace` anchored on comment text an earlier edit had already rewritten. It matched nothing and returned the string unchanged — no error, no route | Re-added with an assertion. Every scripted edit in this codebase now asserts its anchor |
| **Any component throwing blanked the whole application** | No error boundary anywhere. A hot-reload invalidated a context identity, one consumer threw, and the sidebar, conversation and composer all disappeared | `components/ErrorBoundary.tsx`; the floating call widget behind a silent one, the chat workspace behind a visible one. Hot-reload is a development-only *cause*; "one component removes the product" is not a development-only *consequence* |
| The browser gate's cleanup deleted users before files, so it died on a foreign key — and a throwing `finally` swallowed the real failure in the body | Ordering | Files first. A cleanup block that can throw will eventually hide the bug you are looking for |

One more test-side lesson: send is deliberately disabled while an attachment is
uploading, so pressing Enter immediately after choosing a file is a no-op. The
gate now waits for the same condition a person would.
