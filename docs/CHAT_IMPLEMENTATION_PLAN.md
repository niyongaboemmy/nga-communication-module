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

---

## 12. Phase 5 — delivered

**Gate: 28/28 notification checks (green first run), 73/73 browser checks, and
51 + 43 + 35 + 42 on the earlier phases with no regression. 9/9 workspaces
typecheck and build, `npm audit` 0.**

```
npm run verify:chat:notifications   # 28 — mentions, broadcasts, reactions, prefs, quiet hours
npm run verify:chat:ui              # 73 — two real browsers
```

### What was built

| Area | Delivered |
|---|---|
| Mention autocomplete | `@` picker over live membership, keyboard-first (↑↓ / Enter / Tab / Esc), `@here` and `@channel` offered only to people who may actually use them |
| Mention storage | `<@id>` on the wire, resolved to a name at render — a name change leaves no stale copies |
| Reaction notifications | Author only, never for your own, never on un-reacting, and never piercing "mentions only" |
| Delivery | `ChatNotificationBridge` above the router: toast, sound, system notification, tab-title count |
| Preferences | Level, desktop, sound, quiet hours, read receipts, presence, enter-to-send — saved on change |
| Quiet hours | Local minutes-from-midnight, wrapping midnight correctly |
| Badges | One `/api/chat/unread` number for the rail; conversations set to "nothing" excluded |

### Two decisions worth recording

**The bridge lives above the router.** A notification whose entire purpose is to
reach you while you are elsewhere cannot be mounted inside the module it is
about. Mounted in `/app/chat` it would fire only for people already reading
their messages.

**Quiet hours suppress the interruption, never the record.** The row is written
either way, counts towards the badge either way, and is waiting in the morning.
Only the sound and the desktop notification are withheld. The gate asserts
exactly this: a message sent during quiet hours still produces a notification
row and still moves the badge.

**A settings write is whitelisted field by field.** Not spread. The gate posts
`{ role: 'admin', user_id: <someone else> }` at the endpoint and then asserts
the user's role is untouched — a settings route that spreads its body is one
typo from being a privilege-escalation path.

### Defects found this phase

| Defect | Cause | Fix |
|---|---|---|
| The browser gate's page loads timed out after this phase | Every load used `waitUntil: 'networkidle'`, and Tupo holds a Socket.IO connection open for the life of the tab — the network is never idle, so each reload burned its full 30-second timeout | All loads switched to `domcontentloaded` plus an explicit wait on a real element. Confirmed with a request probe that there was no runaway-request loop first, rather than assuming |

`networkidle` had worked by luck up to Phase 4, when the socket happened to
connect after the load settled. It is the wrong condition for any application
with a persistent connection, and it fails intermittently rather than honestly.

---

## 13. Phase 6 — delivered

**Gate: 40/40 power checks (green first run), 93/93 browser checks, and
51 + 43 + 35 + 42 + 28 on the earlier phases with no regression. 9/9 workspaces
typecheck and build.**

```
npm run verify:chat:power   # 40 — search, scheduled send, polls
npm run verify:chat:ui      # 93 — two real browsers
```

### What was built

| Area | Delivered |
|---|---|
| Search | Postgres full-text with quoted phrases and `-exclusions`, filters by conversation / person / date / has-file, own panel with marked hits |
| Command palette | ⌘K over conversations and actions, prefix-ranked, keyboard-only |
| Scheduled send | Presets plus a custom time, a visible and cancellable queue, a worker sweep that claims atomically |
| Polls | Ride on a real message, live results over the socket, single or multi choice, anonymous option, close by the author |
| Slash commands | `/poll /me /shrug /search /saved /scheduled /meet /shortcuts`, with a hint list |
| Shortcuts | ⌘K, ⌘F, ⌘⇧S, Escape to close-or-mark-read, plus a reference sheet |

### Decisions worth recording

**Search access control is a JOIN, not a filter.** Rows come out of
`conversation_members` for the searcher, so there is no ordering of clauses in
which a message from a channel they are not in can appear. The gate posts the
same rare word into a private channel the searcher cannot see and asserts it
never comes back — while the channel's own member does get it.

**The highlight is not HTML.** `ts_headline` wants to emit `<b>`; letting it
would mean the client injecting a string that contains message text as markup,
which is a stored XSS with extra steps. Matches are wrapped in two ASCII control
characters and split into React elements instead. Asserted: `!/<[a-z]/.test(highlight)`.

**Scheduled send is a repeating sweep, not one delayed job per message.** A job
per message sounds tidier and is worse: cancelling means hunting a job by id, a
Redis flush loses every pending send silently, and the queue becomes the source
of truth for something the database already knows. Here the database is
authoritative and the worker is a clock — losing Redis costs punctuality, not
messages. Claiming uses `FOR UPDATE SKIP LOCKED`, and the gate proves a due
message is claimed exactly once.

**An unrecognised `/word` is sent as text.** Refusing to post
"/etc/hosts is the file" would be absurd. A chat that argues with what you typed
is worse than one with no commands at all.

### Defects found this phase

| Defect | Cause | Fix |
|---|---|---|
| **The emoji picker rebuilt its entire DOM about once a second** — measured at 1,432 nodes added and removed in five seconds while it sat open, and it made the buttons intermittently unclickable | `Cell` was declared *inside* `EmojiPicker`. A component defined in another component's body is a new type on every render, so React cannot reconcile it and remounts the whole subtree | Hoisted to module scope and memoised. Churn measured again afterwards: **0** |
| Three controls shared the accessible name "Search messages" — the panel, the input and the button that opens it | Convenience | The input is now "Search term". Indistinguishable names are indistinguishable to a screen reader, whatever they look like |

Two test-side lessons, both of which produced false failures:

- The Phase 5 section turned **enter-to-send off and never turned it back on**.
  That preference is persisted per user, so it leaked into every later section
  and three Phase 6 checks failed because their `Enter` had become a newline. A
  test that changes durable state has to restore it, or it is testing everything
  that comes after it as well.
- Running `npm run build` **concurrently** with a gate rewrites `packages/*/dist`,
  which restarts the API under `tsx watch` mid-run: five gates reported
  `fetch failed` at their first call. Gates and builds are now run sequentially.

---

## 14. Phase 7 — delivered

**Gate: 52/52 administration checks, 105/105 browser checks, and every earlier
phase green with no regression. 9/9 workspaces typecheck and build,
`npm audit` 0.**

```
npm run verify:chat:admin   # 52 — discovery, membership, invites, profiles, retention
npm run verify:chat:ui      # 105 — two real browsers, desktop + phone
```

### What was built

| Area | Delivered |
|---|---|
| Discovery | Public channel directory with search, join in place, "already a member" state |
| Membership | Add, remove, leave, promote, demote, transfer ownership — each permission-gated and announced |
| Invites | 128-bit codes, expiry, use limits, revocation |
| Settings | Topic, archive/reopen, and the disappearing-message policy |
| Profiles | Card behind every avatar with role, pronouns, local time, status, and one action: message them |
| Custom status | Emoji, text and an expiry that is honoured on read, not merely swept |
| Retention | 24 h / 7 / 30 / 90 / 365 days, back-dated onto existing messages, hard-deleted by a worker sweep |

### Decisions worth recording

**A private channel is absent from the directory, not greyed out.** In a school
the *name* is frequently the sensitive part — a channel named for a pupil under
review needs no contents read to do damage — so "you cannot join this" has
already leaked the thing worth protecting.

**Private cannot be made public.** Opening a channel retroactively publishes
everything ever said in it to people who were never party to it. That is not a
settings change, it is a disclosure, so the transition is refused in one
direction only.

**A channel can never be left ownerless.** An admin cannot remove the owner, and
the owner cannot leave without transferring first. Transfer is one transaction:
two owners or none are both worse than the operation failing.

**A disappearing message leaves no tombstone.** "This message was deleted" would
preserve the author, the timing and the fact of it — most of what the setting
exists to remove. The sweep hard-deletes the row and its reactions, receipts,
mentions and attachments.

**Rejoining keeps your read position.** `left_at` rather than a delete, so the
watermark survives and a returning member is not dropped at the top of a channel
they have already read.

### Defects found this phase

| Defect | Cause | Fix |
|---|---|---|
| **Rejoining a channel wiped your saved read position** | The "X joined" system notice is authored by X, and the send path advances the author's watermark to their own message. A rejoin therefore jumped to the bottom | The watermark is no longer advanced for `system` messages. A system notice is not something anyone read |
| **The member list did not refresh after a promotion or removal** — the panel kept showing the old role until it was closed and reopened, so a moderator could not tell whether their click had worked | Members were fetched once per panel-open | A version counter the mutation bumps, plus a `conversation:member_changed` socket listener so a change made by *anyone* in the room lands |

One gate assumption was wrong rather than the code, twice over: `CHANNEL_ARCHIVE`
is a Moderator permission and not a Staff one, so both the API and browser gates
were asserting against a role that correctly cannot archive. The API gate now
uses a Moderator and additionally asserts the Staff refusal; the browser gate
asserts the control is **hidden** for Staff, which is the honest UI expectation.

---

## 15. Definition of done — met

| Criterion | Result |
|---|---|
| All 7 phase gates green | ✅ 51 + 43 + 35 + 42 + 28 + 40 + 52 = **291 API/socket checks** |
| Browser verification | ✅ **105 checks** across two live browsers, desktop and phone |
| `npm run typecheck` | ✅ 0 errors, 9 workspaces |
| `npm run build` | ✅ 0 errors; web bundle 229 kB gzipped |
| `npm audit` | ✅ 0 vulnerabilities |
| Every `M` feature in §2 | ✅ implemented and covered by a gate check or a documented browser pass |

**396 automated checks in total**, all runnable against the live stack:

```
npm run verify:chat                # spine
npm run verify:chat:live           # reactions, edits, deletions, notifications
npm run verify:chat:threads        # threads, quotes, pins, saves, forwarding
npm run verify:chat:files          # attachments and the access rule
npm run verify:chat:notifications  # mentions, preferences, quiet hours
npm run verify:chat:power          # search, scheduling, polls
npm run verify:chat:admin          # channels, invites, profiles, retention
npm run verify:chat:ui             # two real browsers
```

Run the gates **sequentially and not alongside a build** — `npm run build`
rewrites `packages/*/dist`, which restarts the API under `tsx watch` mid-run.

---

## 16. Polish pass — mentions, meetings, and the rough edges

**Gate: 416 checks, 0 failures** (291 → 416 as the new checks landed).
9/9 workspaces typecheck and build, `npm audit` 0.

### The mention problem, in full

Mentions are *stored* as `<@id>` so a name change leaves no stale copies in
history. That is right, but the display side was only half-built, and it showed
in four different places at once:

| Surface | Was | Now |
|---|---|---|
| Message log | `@someone` for anyone who had not spoken in the loaded window | The real name, always |
| Sidebar preview | `@mention` | `@Aline Uwase` |
| Notification body | `can @someone cover period 4` | `can @Aline Uwase cover period 4` |
| Search results | raw `<@2161…>` | The real name |

The root cause was that the client *inferred* names from the senders it had
loaded. The fix is `mentionNames` on `WireMessage`, resolved server-side for a
whole page in one query, plus `renderMentionsAsText` for the three surfaces that
are plain strings with no React tree to build pills into.

A mention of a deleted account degrades to "Unknown person" rather than printing
an id at the reader. Asserted.

### Meeting shortcut

A calendar control beside the composer, and `/meet`. It reuses Meet's own
`QuickSchedule` **verbatim** rather than reimplementing it — that component
already knows not to propose a time in the past, to clamp suggestions to hours a
school meets in, and to offer chips rather than a masked time input. A second
copy of that judgement would drift within a month.

Two things it does that a pasted link cannot:

- The meeting is created with `conversationId`, and Meet's join path already
  treats membership of that conversation as a grant — so everyone in the channel
  can join without being individually invited. No new access model was needed;
  `meetings.conversation_id` already existed.
- The message is a `call_event` carrying the meeting id, rendered as a **live
  card**: "Live now · 3 in the room", or "Ended", or the scheduled time. A URL
  posted an hour ago cannot say any of that. The body text remains as the
  fallback that notifications, previews and search read, and is not drawn when
  the card renders.

### Smoothness

| Added | Why |
|---|---|
| Typing shows in the sidebar row, not only in the open conversation | Where WhatsApp puts it, and where it answers "are they replying?" |
| Emoji-only messages render large and without a bubble | A lone 👍 in 14px body text inside a bubble reads as a typo |
| `↑` on an empty composer edits your last message | It was advertised in the shortcut sheet and not bound |
| `⇧Esc` marks everything read | Same |

### Defects found

| Defect | Cause | Fix |
|---|---|---|
| **The shortcut sheet advertised two shortcuts that did not exist** | Written a phase ahead of the implementation | Both implemented. A reference that lies is worse than a shorter one — people stop trusting the rest of it |
| **`⇧Esc` did nothing where people actually are** | The whole Escape branch was gated behind "not typing", and the composer is focused by default | The chord is handled before that guard. Plain Escape still belongs to the composer; a two-key chord does not |
| **The sidebar showed `<@2161…>` for a message you had just sent** | The socket path rebuilds the preview locally so the list moves instantly, and it used the raw body — the server's resolved preview was overwritten | The client resolves mentions too, from `mentionNames` |
| **`<div>` inside `<p>`, and a hydration warning** | `Spinner` rendered a `<div>`, and a spinner belongs inside paragraphs, buttons and headings — all phrasing-content only | `Spinner` is now a `<span>` with an accessible name. Fixed at the source, so all 28 call sites are correct |

Two test-side notes: the new sidebar typing line made an unscoped
`getByText(/is typing/)` match twice, and `↑` correctly refuses to edit a message
that is still sending — the gate now waits for the delivery tick rather than
racing the ack.

### Still not done at the end of §16

Message-list virtualisation, link unfurling, and inline translation. All
`S`/`C` priority in §2. §17 closes all three.


## 17. The last three — unfurling, translation, virtualisation

### Link unfurling (FR-MSG-24)

`0013_link_previews.sql` adds `link_previews`, keyed by the SHA-256 of the
*normalised* URL rather than the URL as typed, so the same page shared with a
tracking parameter and without it is fetched once; and `message_links`, joining
messages to previews.

The whole of `packages/chat/src/unfurl.ts` exists because fetching a URL a user
typed is a server-side request forgery primitive. It is not enough to reject
`127.0.0.1` by string: the defence is to resolve the hostname, check every
returned address against the blocked ranges, and then **pin the connection to
the address that was checked** — otherwise DNS can return a public address for
the check and a private one for the fetch. Redirects are followed manually
(`redirect: 'manual'`) so each hop is re-resolved and re-vetted; letting the
runtime follow them would skip the guard on every hop after the first. The
body is capped at 512 KB and parsed with regexes, never a DOM parser, because a
DOM parser on hostile input is a second attack surface for no benefit.

Blocked: loopback, link-local (including `169.254.169.254`, the cloud metadata
endpoint), RFC 1918, CGNAT, and the IPv6 equivalents — including
`::ffff:10.0.0.1`, the IPv4-mapped form that a naive range check misses.

Unfurling is enqueued, never inline: it runs as job `chat:unfurl` from both the
REST route and the socket path, and the worker re-emits `message:updated` when
a preview lands. Sending a message must not wait on a third-party host.

14 unit tests cover the address ranges specifically, including the edges that a
wrong bitmask gets wrong in the *permissive* direction — `172.15.x` and
`172.32.x` must be allowed, and a check that only ever asserts blocking would
pass with everything blocked.

### Inline translation (FR-MSG-25)

`0014_message_translations.sql` caches per `(message_id, language)` — but with
a `source_hash` column, so an edit invalidates the cache. Without it the feature
misleads: someone reads a corrected message and gets the translation of the
uncorrected one.

Three languages (English, Kinyarwanda, French), a closed list, because an open
language list means an open prompt. The message is fenced between markers and
the prompt states that the text between them is data and must never be
followed — a chat message is untrusted input, and someone will type "ignore
your instructions" into a school chat to see what happens.

The UI renders the translation *under* the original, labelled as a machine
translation and dismissible, and only on other people's messages.

### Message-list virtualisation (U-6)

`useVirtualWindow.ts`, and deliberately not a conventional virtualiser. The
usual approach — absolutely positioned rows over a measured spacer — needs a
height for every row before it renders. A chat message has no such thing: it
wraps to an unknown number of lines, may carry an image whose aspect ratio is
only known after layout, and grows when someone adds a reaction.

Instead it renders a contiguous window plus 40 rows of overscan and pads the
gap with two plain spacer elements whose height comes from the *measured*
average of what has actually rendered. Rows keep their natural height, nothing
is positioned absolutely, and the browser's own scroll anchoring keeps working.
Below 200 messages it is inert.

#### The check that passed for the wrong reason

The first version of the gate posted 600 messages, loaded the conversation and
asserted the DOM held fewer than 200 rows. It passed. It proved nothing: the
thread pages ~40 messages at a time, so the DOM was small because most of the
log had never been fetched. Windowing had not engaged at all.

The second version tried to detect the crossing by watching the rendered row
count climb past 240 — which is unreachable *by construction*, since capping
that number is precisely what windowing does.

The honest measure is scroll extent, which reflects every message the client
holds whether rendered or spacered. The gate now scrolls back until the
scroller exceeds 15,000 px and then asserts the DOM holds under 200 rows.
Measured: **606 messages, 16,311 px of scroll, 99 rows in the DOM**, ≥93 % of
the viewport covered by real rows at every scroll position tested (blank space
is the failure mode that matters), and the very first message still reachable.

#### Defect found on the way

`loadOlder` had no `catch`. A page request that failed left the error
unhandled; worse, any future change that set `hasMore = false` in that path
would silently truncate history and look identical to reaching the top. It now
catches and deliberately leaves `hasMore` alone — a page that failed to load is
not the top of the conversation.

`LinkPreviewCard` gained a `data-link-preview` attribute: the card and a plain
autolink were indistinguishable to a test, and the first version of the preview
check was matching the autolink.

### Regression at the close of §17

| Gate | Result |
| --- | --- |
| core | 51 / 0 |
| live | 43 / 0 |
| threads | 35 / 0 |
| files | 42 / 0 |
| notifications | 34 / 0 |
| power | 54 / 0 |
| admin | 52 / 0 |
| ui (browser) | 132 / 0 |
| unit tests | 233 / 0 |

Typecheck clean, build clean, `npm audit --omit=dev` 0 vulnerabilities.

Two false failures were seen and traced, not papered over: an API gate run and
a `--workspaces` test run both failed while a package rebuild was restarting
the services under `tsx watch`. Both passed on a clean re-run. The standing
rule holds — gates run sequentially, and never alongside a build.


## 18. The people picker — six identical rows

Reported from the running app: the "New conversation" dialog listed six people
all called "Aline Uwase", all "Staff", all with the same initials and the same
avatar colour.

### It was not a duplicate query

The first thing to rule out. `/api/chat/directory` is a single-table `SELECT`
with no join, so it cannot fan out rows. The six entries were six genuinely
distinct accounts that happened to share a display name.

Which means the bug is not "stop duplicating" — it is that **the picker gave no
way to tell two accounts apart**, and that is a defect even with one duplicate
name in the whole school. A name is not an identifier.

### The fix

- `/api/chat/directory` now returns `email`, and matches it in the search — if
  you know which one you want, you know their address. Ordered by
  `name, email` so same-named people have a stable order rather than whatever
  the planner chose that day.
- The row shows the address **only where the name repeats in the current result
  set**. Showing everybody's email all the time is noise; showing it exactly
  where the list is ambiguous is the whole fix.
- `Avatar` gained `tintKey`. The tint was derived from the name, so identical
  names got identical colours; the picker keys it on the user id instead.

### Interaction

The dialog was mouse-only. It now behaves like a recipient field:

- `role="combobox"` over a `role="listbox"`, with `aria-activedescendant` — ↑/↓
  move the highlight without the caret leaving the search box, ↵ picks.
- ↵ in multi-select clears the box so the next name can be typed straight away.
- Backspace on an empty box removes the last chip.
- ⌘/Ctrl+↵ submits from anywhere, including the name and topic fields.
- The matched substring is highlighted in both name and address.
- The footer says what will happen ("Opening a chat with …", "3 people added")
  rather than leaving the button as the only feedback.
- Chips carry the avatar and an accessible "Remove <name>" label.

### Why there were six

Not a product bug: leftover test accounts from my own gate runs. Worth fixing
properly, because it is a real class of defect.

Teardown ran inside a `finally` as:

    DELETE FROM conversations WHERE ...;
    DELETE FROM users WHERE ...;

If any of those conversations still had messages, the first statement failed on
the foreign key, the `finally` threw, and the second never ran — so **every
interrupted run leaked its whole cast of users**, silently. Three interrupted
chat runs and two meet runs had accumulated 20 accounts.

`scripts/lib/purge.mjs` replaces it: deletion in dependency order, each step in
its own try/catch, so a failing step can neither stop the remaining steps nor
mask the error the test was actually reporting. Wired into all eight chat gates
and into `verify-meet-prejoin.mjs` — which had no `try/finally` at all, and is
where the two "Aline Uwase" rows came from. Verified: a full eight-gate sweep
now leaves **0** test accounts behind.

### Checks added

Two accounts are created with a deliberately identical name, and the gate
asserts both appear, both show their address, they get **different** avatar
tints, searching by address narrows to one, ↓ moves `aria-activedescendant`,
and ↵ selects the second row rather than the first.

One selector had to change: the person rows are `role="option"` now, so
`getByRole('button', …)` no longer matches them — an accessibility improvement
that a test was silently depending on the absence of.

UI gate: **139 / 0**. API gates unchanged at 51/43/35/42/34/54/52, unit tests
233 / 0, typecheck and build clean.
