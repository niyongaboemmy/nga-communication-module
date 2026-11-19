# Tupo chat: replies and conversation-flow UX gap analysis

**Date:** 19 November 2026
**Companion to:** [CHAT_COMPOSER_GAP_ANALYSIS_2026-11-19.md](CHAT_COMPOSER_GAP_ANALYSIS_2026-11-19.md), which covers typing, slow networks and data loss. This report is about **reading and following replies**, and about the other friction found along the way.
**Branch reviewed:** `feat/responsiveness-m5b` (head `12ceb94`)

**Method:**
- Code review of `apps/web/src/pages/chat` and `packages/chat`.
- A **live run**: a seeded `#s4-mathematics` channel with 4 people, 2 threads (5 and 3 replies), 3 quote replies and one thread reply also sent to the channel.
- Screenshots from desktop (1440×900) and phone (390×844, touch), driven by Playwright, saved in [chat-replies-audit-2026-11-19/](chat-replies-audit-2026-11-19/).

---

## 1. Summary

"It is not easy to view replies" has three layers:

1. **Quote replies are visually broken.**
   - The quoted line never wraps, so it stretches the bubble wider than the screen.
   - On a phone, your own reply to a long message shows **only the end of the quote**. The words you actually wrote are off-screen (§3, R-01).
   - Every quote reply in a channel runs off the right edge.
   - This alone makes replies unreadable.
2. **Threads are hidden behind a small link and a separate pane.**
   - A thread is shown in the channel only as a small blue "5 replies" link.
   - There are no faces, no "who replied", no time and no preview.
   - Reading it opens a side panel. On a phone that panel covers 90% of the screen, with the chat peeking out behind it.
   - Inside the panel, replies **cannot be reacted to, replied to, edited, deleted, copied or reported**. The panel is read-only.
3. **Two reply verbs, and neither is called "Reply".** The hover bar has a quote-mark icon (Messenger-style reply) and a curved-arrow icon (thread). People expect the arrow to mean "reply", and it opens a side panel instead.

Facebook handles the same problem with one verb ("Reply"):
- **Comments:** replies sit *under* the comment, collapsed to a summary line with faces ("Didier and 2 others replied · 5 replies"), and expand in place.
- **Messenger:** a reply shows a faded, wrapped copy of the original *above* the reply, labelled "You replied to Bosco", and tapping it jumps there.

§2 maps these patterns onto Tupo without losing what the side-panel design was protecting: a busy class channel must stay readable.

Beyond replies, the live run found **13 more conversation-flow gaps**. The most visible:
- the sticky "Today" chip sits on top of message text;
- the phone long-press menu is the desktop hover bar (11 unlabelled 28 px icons) plus a dropdown cut off by the composer;
- a conversation opens at the newest message, not at the first unread one.

---

## 2. The reference: how Facebook makes replies easy to see

| Pattern | Facebook (comments) | Messenger | Tupo today |
|---|---|---|---|
| One verb | "Reply" under every comment | Swipe, or long-press → Reply | Two icons: " (quote) and ↩ (thread) |
| Replies visible in context | Under the parent, collapsed: avatars + "View 5 replies" | n/a (no threads) | Small "5 replies" link only |
| Summary line | Avatar of a replier, "X replied · N replies" | n/a | Count only; `threadLastAt` exists but is not shown |
| Expand | In place; "View previous replies" pages older ones | n/a | Opens a side panel |
| Reply to a reply | Stays one level deep; pre-fills `@Name` | Quote of the reply | Impossible inside a thread |
| Quoted message | n/a | "You replied to Bosco", a faded bubble that wraps 2–3 lines, media thumbnail | One no-wrap line that overflows; "attachment" as text |
| Tap the quote | n/a | Scrolls to the original and highlights it | Same, but no way back to where you were |
| Being replied to | "X replied to your comment" notification | Reply counts as a message to you | No notification for quote replies |
| Phone | Full screen; back returns | Full screen | 90 vw overlay, X in the corner, not in the URL |

### 2.1 Proposed design for Tupo (channels and groups)

Keep threads, but show them **Facebook-style inline**, collapsed by default and capped. The original concern ("forty replies push everything off the screen", [ThreadPanel.tsx:1-12](../apps/web/src/pages/chat/ThreadPanel.tsx#L1-L12)) is met by the cap. The panel remains as a focus mode for long threads.

**Collapsed (the default; one line under the root):**
```
 CM  Claire Mukamana · 2:33 PM
     ┌──────────────────────────────────────────────────────┐
     │ Who can share last week's homework solutions for 5.3? │
     └──────────────────────────────────────────────────────┘
     (DH)(BR)  Didier and Bosco replied · 5 replies · 2 min   ← whole line tappable
```

**Expanded in place (tap the line; the latest 3 are shown):**
```
     │  View 2 earlier replies
     ├─ DH  Didier · 2:34   Here: 1) 12  2) 7/3  3) x>4 …          ♥ 2
     ├─ CM  Claire · 2:35   Thank you both!
     └─ BR  Bosco  · 2:36   Also check 5.3 q6, many got it wrong
        [ Reply to Claire…                              ] [↗ Open thread]
```

**Rules:**
- **When the inline view is used.** At most 3 replies inline and one level deep. Above 10 replies, or when the person taps "Open thread", the side panel opens (full screen on a phone).
- **Reply to a reply.** It stays in the same thread and pre-fills `@Name`, as Facebook does. It is never nested deeper.
- **Who sees it expanded.**
  - Collapsed for everyone by default.
  - Auto-expanded for a person who has unread replies in that thread. The "new" replies are tinted.
  - The open or closed state is remembered per thread on that device.
- **DMs.** A DM has no threads. "Reply" is the quote reply, as in Messenger.

**One verb.** The hover bar and the phone sheet show **Reply**, which is the quote reply in DMs and the thread reply in channels. "Quote in channel" moves to the ⋯ menu, for the cases where a person really wants a quote in the main flow. Swiping right on a phone does the same as Reply.

---

## 3. Findings: replies

Severity: **Critical** = content unreadable or lost · **High** = a common path is broken or misleading · **Medium** = friction · **Low** = polish.

### R-01: Quote replies overflow the bubble and the screen (critical)

**Evidence:**
- [01-desktop-channel.png](chat-replies-audit-2026-11-19/01-desktop-channel.png): "Yes, 9 to 12" and "Thursday works for me" stretch past the right edge.
- Ada's own reply is pushed off the left edge ("ood morning class…").
- [07-phone-channel.png](chat-replies-audit-2026-11-19/07-phone-channel.png): on a phone, Ada's reply shows only "…ise chapters 4 to 6 (quadratics, inequalities, and sequences)." The sentence she wrote is not visible at all. The left column of the page also shifts sideways ([03](chat-replies-audit-2026-11-19/03-desktop-thread-open.png)), which means the whole page scrolls horizontally.

**Cause:** the quote is a `block w-full truncate` button ([MessageThread.tsx:436-448](../apps/web/src/pages/chat/MessageThread.tsx#L436-L448)). `truncate` means `white-space: nowrap`, so the bubble's natural width becomes the full length of the quoted sentence. The bubble has no `max-w-full`/`min-w-0` of its own, so it grows past the `max-w-[min(46rem,85%)]` column ([:372](../apps/web/src/pages/chat/MessageThread.tsx#L372)).

**Fix:**
- Give the bubble `max-w-full min-w-0 overflow-hidden`.
- Render the quote as a wrapped block clamped to 2 lines (`line-clamp-2`, normal `white-space`).
- Add a visual regression test that has a long quote in both directions.

### R-02: The thread entry point is too weak to notice (high)

**Evidence:** "5 replies" is 11 px blue text with a tiny icon ([01](chat-replies-audit-2026-11-19/01-desktop-channel.png), [07](chat-replies-audit-2026-11-19/07-phone-channel.png)), rendered at [MessageThread.tsx:556-569](../apps/web/src/pages/chat/MessageThread.tsx#L556-L569). It says nothing about who replied, when, or what was said.
- The message already carries `threadLastAt`, which is unused.
- The API can cheaply add the last 2–3 repliers' ids, names and avatars.

**Fix:**
- Use the §2.1 summary line: stacked avatars, "Didier and 2 others replied · 5 replies · 2 min", at 13 px and at least 44 px tall on touch.
- Add the participant faces to the message payload (`threadParticipants`).

### R-03: Replies can only be read in a separate pane (high)

**Evidence:** tapping the link opens the side panel ([03](chat-replies-audit-2026-11-19/03-desktop-thread-open.png)). On a phone it is an overlay 90 vw wide with the chat and scrim showing at the left ([09](chat-replies-audit-2026-11-19/09-phone-thread-open.png)), from `SidePanel` `max-w-[90vw]` in [ChatLayout.tsx:63-68](../apps/web/src/pages/chat/ChatLayout.tsx#L63-L68).

To read a 2-reply answer to a question, a person must:
1. open a pane;
2. find the answer;
3. close the pane;
4. find their place again.

**Fix:**
- Inline expansion as in §2.1.
- On a phone, the thread is a full-screen page with a ← back control in the same header style as a conversation.

### R-04: Replies inside a thread cannot be acted on (high)

**Evidence:** the live run counted **0 buttons** inside the thread's message list ([03](chat-replies-audit-2026-11-19/03-desktop-thread-open.png); `ThreadMessage` in [ThreadPanel.tsx:14-72](../apps/web/src/pages/chat/ThreadPanel.tsx#L14-L72)). Its reactions are plain `<span>`s.

Inside a thread you cannot:
- react, or tap an existing reaction to add yours;
- reply to a specific reply (quote or `@`);
- edit or delete your own reply, which is a moderation gap as well (B-13 lets channel moderators remove messages, but not thread replies from here);
- copy, save, forward, pin or report;
- see pending or failed delivery (the thread has no optimistic send; see G-07 in the companion report).

**Fix:**
- Render thread replies with the same `MessageRow` used by the main flow, in a compact variant (no bubbles, one column).
- Then every action, gesture and delivery state works for free.

### R-05: The thread has no address (medium)

**Evidence:** with a thread open, the URL stays `/app/chat?c=…`.
- `thread` is excluded from `PANELS_IN_URL` on purpose ([ChatLayout.tsx:47-48](../apps/web/src/pages/chat/ChatLayout.tsx#L47-L48)).
- So a thread cannot be linked, survive a reload, or be opened directly from a push notification or an email digest.
- Android's back button leaves the chat instead of closing the thread.

**Fix:** add `?thread=<rootId>` to the URL. Back closes the thread, and notifications for thread replies open it directly.

### R-06: Two reply icons; the familiar one does the unfamiliar thing (medium)

**Evidence:** the hover bar shows `"` (Quote reply) and `↩` (Reply in thread) side by side ([MessageThread.tsx:619-625](../apps/web/src/pages/chat/MessageThread.tsx#L619-L625); bar visible in [03](chat-replies-audit-2026-11-19/03-desktop-thread-open.png)). Neither has a visible label. Everywhere else (Facebook, Messenger, WhatsApp, Gmail), the curved arrow means "reply here", yet in Tupo it opens a side panel.

**Fix:** one **Reply** action (§2.1), shown with its text label on the phone sheet (C-02). "Quote in channel" goes in the ⋯ menu.

### R-07: "Also send to channel" copies are disguised as quote replies (medium)

**Evidence:** Bosco's thread reply sent to the channel appears as an ordinary quote of Claire's question ([01](chat-replies-audit-2026-11-19/01-desktop-channel.png), second message).
- The server marks it with `metadata.fromThread` ([packages/chat/src/service.ts:2102-2110](../packages/chat/src/service.ts#L2102-L2110)), but the web app never reads that field.
- Tapping the quote jumps to the root instead of opening the conversation it came from.
- Readers cannot tell that a discussion is happening.

**Fix:**
- Show a small header, "Replied in a thread · View 5 replies", which opens the thread.
- Use `fromThread` to choose that rendering.

### R-08: The quote preview carries too little (medium)

**Evidence:** [MessageThread.tsx:443-447](../apps/web/src/pages/chat/MessageThread.tsx#L443-L447) shows the sender's name and one line of text. A photo, voice note or file becomes the word "attachment". The quote in your own message is drawn at `white/80` on blue, which is low contrast. There is no "You replied to Bosco" label, so a reply looks like a forward or a pasted note.

**Fix:**
- Messenger's treatment: a label above the bubble ("You replied to Bosco" / "Claire replied to you").
- The quoted text clamped to 2 lines.
- For media, a 32 px thumbnail plus type and length ("📷 Photo", "🎤 Voice message · 0:12", "📄 Notes.pdf").
- Check that contrast meets WCAG AA.

### R-09: Being replied to is not a notification (high)

**Evidence:** `reply_to_id` is only validated and stored ([service.ts:583-598](../packages/chat/src/service.ts#L583-L598), [:708-714](../packages/chat/src/service.ts#L708-L714)). No code path we found notifies the author of the quoted message or counts it toward their mentions. In a channel set to "mentions only", or a muted one, a teacher whose announcement gets a student's question as a quote reply never hears about it.

**Fix:**
- Treat "replied to your message" like a mention: it adds to `unreadMentions`, sends a push titled "Claire replied to you", and goes to the notification centre.
- Allow people to opt out in the notification settings.

### R-10: No way back after jumping to a quoted message (medium)

**Evidence:** tapping a quote scrolls to the original and highlights it for 2.2 s ([05](chat-replies-audit-2026-11-19/05-desktop-after-quote-jump.png)). The only way back is "Jump to latest", which goes to the end of the conversation, not to the reply you came from. The live run found no "back" control.

**Fix:** after a jump, show a "↩ Back to reply" pill that returns to the reply's position. Keep a small stack for chains of jumps.

### R-11: Following is invisible and cannot be changed (medium)

**Evidence:** you follow a thread only by writing in it ([service.ts:2121-2160](../packages/chat/src/service.ts#L2121-L2160)). There is no follow or mute control anywhere in the code. In the live run, Ada (the teacher who created the channel) did not follow the homework thread, so new replies to it would never reach her Threads inbox. A student cannot silence a noisy thread they replied to once.

**Fix:**
- Add a "Follow / Following ✓" toggle in the thread header and on the summary line.
- Auto-follow when you are @mentioned in a thread or when it is in a channel you own or moderate.

### R-12: Opening a thread drops you at the bottom, with no "new" marker (low)

**Evidence:** [ThreadPanel.tsx:108-110](../apps/web/src/pages/chat/ThreadPanel.tsx#L108-L110) always scrolls to the end, and the thread has no "new replies" divider like the main flow's. In a 30-reply thread with 6 new replies, the reader cannot see where the new ones start.

**Fix:** use the main flow's first-unread divider in the thread, and open at it.

### R-13: The Threads inbox shows the question, not the answer (low)

**Evidence:** each row shows the root preview and a count ([ThreadsInbox.tsx](../apps/web/src/pages/chat/ThreadsInbox.tsx)). It does not show who replied last or what they said, which is the thing a person opening the inbox wants to know.

**Fix:**
- Add a last-reply line ("Bosco: Also check 5.3 q6…") with the replier's avatar.
- Add an "Unread" filter.

---

## 4. Findings: conversation flow and phone ergonomics

### C-01: The sticky date chip covers message text (high, visual)

**Evidence:** "Today" sits on top of Claire's message ([01](chat-replies-audit-2026-11-19/01-desktop-channel.png)) and of the quote line on a phone ([07](chat-replies-audit-2026-11-19/07-phone-channel.png), [10](chat-replies-audit-2026-11-19/10-phone-longpress-menu.png)). It comes from the `sticky top-0` day `<li>` in the message list.

**Fix:** give the sticky chip a solid backdrop strip the full width of the list (so text scrolls *under* it, not through it), or show it only while scrolling, as Messenger and WhatsApp do.

### C-02: Phone long-press shows the desktop toolbar plus a clipped menu (high)

**Evidence:** [10-phone-longpress-menu.png](chat-replies-audit-2026-11-19/10-phone-longpress-menu.png).
- A long press opens the hover bar: 11 icon-only buttons about 28 px each, under the 44 px touch minimum.
- It also opens a dropdown, which the composer cuts off ("Report message" is half hidden).
- The bar covers the sender's name, and the message is not set apart from the rest.
- The menu items (Copy text, Copy link, Mark unread, Report) are not the common actions; Reply is an unlabelled icon.

**Fix:** a Messenger-style **bottom sheet**:
- a dimmed backdrop, with the pressed message raised above it;
- a quick reaction row above the message;
- labelled rows below: Reply, Forward, Copy, Save, Pin, Edit, Delete, Report;
- a haptic tick when it opens.

On a phone, never show the hover bar.

### C-03: A conversation opens at the newest message, not the first unread (medium)

**Evidence:** `atBottom` starts as `true`, and the layout effect scrolls to `bottomRef` ([MessageThread.tsx:818](../apps/web/src/pages/chat/MessageThread.tsx#L818), [:847-850](../apps/web/src/pages/chat/MessageThread.tsx#L847-L850)). A "New messages" divider is drawn ([:1015](../apps/web/src/pages/chat/MessageThread.tsx#L1015)), but nothing scrolls to it. Someone who comes back to 40 unread messages in a class channel lands on the last one and has to scroll up to find where they stopped.

**Fix:** on open, if the divider exists and is more than one screen above the bottom, scroll it to the top third of the view. The pill then reads "↓ 40 new messages".

### C-04: The "Jump to latest" pill covers content (medium)

**Evidence:** it sits on top of message text and toolbars ([03](chat-replies-audit-2026-11-19/03-desktop-thread-open.png), [05](chat-replies-audit-2026-11-19/05-desktop-after-quote-jump.png), [10](chat-replies-audit-2026-11-19/10-phone-longpress-menu.png)).

**Fix:**
- Make it a round button in the bottom-right corner, above the composer, with an unread badge (the WhatsApp position).
- Reserve bottom padding in the list so the last message is never hidden behind it.

### C-05: The hover toolbar stays stuck after opening a thread (low)

**Evidence:** in [03](chat-replies-audit-2026-11-19/03-desktop-thread-open.png), the root message still shows its full toolbar after the panel opened, because focus stayed in the bar.

**Fix:** blur the bar, or move focus into the thread composer, when a toolbar action opens a panel.

### C-06: The phone composer placeholder wraps to two lines (low)

**Evidence:** "Message #s4-mathematics-0e7d" wraps and makes the composer twice as tall ([07](chat-replies-audit-2026-11-19/07-phone-channel.png)).

**Fix:** on a phone, use "Message" for channels and the first name for DMs, and keep the placeholder on one line (`text-overflow: ellipsis`).

### C-07: The opened thread loses the main list's scroll position (low)

**Evidence:** opening the side panel narrows the main list. Rows re-wrap, and the reader's place shifts: in [03](chat-replies-audit-2026-11-19/03-desktop-thread-open.png) the root moved to the bottom edge, under "Jump to latest".

**Fix:** anchor the message the thread was opened from, and restore its offset after the width change. A `ResizeObserver` on the list can correct `scrollTop`.

### Also noted (not reproduced visually; from the code)

- **No "is replying…" in threads.** Typing is shown per conversation, never per thread. Add "Didier is replying…" under the expanded thread summary.
- **Role label on every message.** "Staff" is shown at every new message group, which adds noise in a staff room. Show it only when it differs from the reader's own role, or only for the teacher in student channels.
- **Inline thread composer.** With §2.1, the inline "Reply to Claire…" field must follow the composer fixes in the companion report (local state, IME guard, clear at send time). Otherwise it inherits G-01, G-03 and G-06.

---

## 5. Priority and delivery

| Batch | Items | Outcome | Size |
|---|---|---|---|
| **1. Make replies readable** | R-01, C-01, C-04, C-06 | Quotes wrap inside the bubble, nothing sits on top of text, no sideways scrolling | ~1 day |
| **2. Facebook-style replies** | R-02, R-03, R-06, R-07, R-08, R-10 | One "Reply", a summary line with faces, inline expansion, labelled quotes with thumbnails, back after a jump | 3–4 days |
| **3. Threads that work fully** | R-04, R-05, R-11, R-12, C-05, C-07 | Thread replies use `MessageRow` (all actions), `?thread=` deep links, follow toggle, unread divider | 2–3 days |
| **4. Phone ergonomics and attention** | C-02, C-03, R-09, R-13 | Bottom action sheet, open at the first unread, "replied to you" notifications, a better inbox | 2–3 days |

Batch 1 is pure CSS and layout, low risk, and fixes the two problems anyone notices in the first ten seconds. Batches 2 and 3 should be built on the composer refactor (batch 2 of the companion report), because the inline thread composer reuses it.

---

## 6. Acceptance criteria

1. At 360, 390 and 1440 px, a quote of a 300-character message never makes a bubble wider than its column, and the page never scrolls sideways.
2. Under a message with replies, a person can see who replied and when **without opening anything**. One tap shows the latest 3 replies in place.
3. On a phone, a thread opens full screen. Back closes it, and the URL contains `thread=`.
4. Every action available on a main-flow message (react, reply, edit, delete, copy, save, report) is available on a thread reply.
5. When someone quote-replies to my message, I get a notification and a mention badge, even in a mentions-only channel.
6. After tapping a quote, one tap returns me to the reply I started from.
7. A long press on a phone opens a bottom sheet with labelled actions, every target at least 44 px, and nothing cut off by the composer.
8. Opening a conversation with unread messages lands at the "New messages" divider.

## 7. How to re-run the audit

The live run used a throwaway Playwright script, since removed. It seeded 4 `chatui-` users and a channel through the API, then took screenshots with `scripts/lib/uiHarness.mjs` (`prepareBrowser`).

To keep these checks permanently, add `verify:chat:replies` modelled on `verify:chat:threads` plus `verify-chat-ui.mjs`, asserting the criteria above. Include a check for bubble width against the column and for `document.documentElement.scrollWidth <= innerWidth`.

The repo's Playwright expects chromium build 1234, but the machine has 1254. Run `npx playwright install chromium` first, or pass `executablePath`.
