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
