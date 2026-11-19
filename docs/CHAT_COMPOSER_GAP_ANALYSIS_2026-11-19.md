# Tupo chat: typing, composer and slow-network gap analysis

**Date:** 19 November 2026
**Scope:** the chat composer and everything a person types into in chat: main composer, thread reply box, inline message edit. Also the send, retry and offline paths those boxes feed.
**Branch reviewed:** `feat/responsiveness-m5b` (head `12ceb94`)
**Method:** code review of `apps/web`, `apps/api` and `packages/shared`. Nothing here was reproduced in a browser yet. §7 lists the tests that would confirm each finding.

---

## 1. Summary

The reported symptom: on a slow network, typed text shows up late, deleting a character is hard, and typos appear.

This has **two independent causes**, and both are in the code today:

1. **The draft echo overwrites what you are typing (network-dependent, the main cause).**
   About 800 ms after each pause, the composer saves the draft to the server. The server then broadcasts `conversation:draft` back to **every socket of that user, including the tab that is typing**. The client applies that echo without checking it. The echo carries the text from the moment of the save. On a slow line, the person has kept typing or deleting by the time it arrives, so their newer text is replaced with the older one and the caret jumps to the end.
   - Deleted characters come back.
   - New characters disappear.
   - The next keystrokes land in the wrong place.
   This matches the report exactly, and it gets worse as latency grows.

2. **Every keystroke re-renders the whole chat screen (device-dependent, makes it worse).**
   The composer's text is stored in the global `ChatProvider` state, and the provider's context value is a new object on every render. Each keystroke therefore re-renders all 26 `useChat()` consumers, including **every visible message row** (up to 200 before windowing starts), the conversation list and the header. On a low-end Android phone this alone drops keystrokes. Android keyboards are also known to lose or double characters in a controlled React textarea when re-renders are slow.

Beyond typing, the review found **14 more gaps**:
- three cases where text the person typed is lost without a message;
- no request timeouts anywhere, so a slow line hangs instead of failing;
- no IME (composition) handling.

Section 3 has the severity table.

---

## 2. The reported symptom, traced

### 2.1 Draft echo race (G-01, critical)

**The chain in the code:**

| Step | Where | What happens |
|---|---|---|
| 1 | [Composer.tsx:56](../apps/web/src/pages/chat/Composer.tsx#L56), [:604-610](../apps/web/src/pages/chat/Composer.tsx#L604-L610) | The textarea is controlled: `value = draftFor(conversation.id)`, and `onChange` calls `setDraft`. |
| 2 | [ChatProvider.tsx:1019-1027](../apps/web/src/pages/chat/ChatProvider.tsx#L1019-L1027) | `setDraft` updates state and, after an 800 ms debounce, sends `PUT /conversations/:id/draft` with the text *as it was then*. Requests that are still in flight are not cancelled, and they carry no sequence number. |
| 3 | [routes/chat.ts:425-435](../apps/api/src/routes/chat.ts#L425-L435) | The server saves the draft and calls `emitToUsers([me.id], 'conversation:draft', …)`. This reaches every socket of the user, **including the one that sent the PUT**. The event's own doc comment says it is for "a draft saved on another device" ([chatEvents.ts:242](../packages/shared/src/chatEvents.ts#L242)), but nothing enforces that. |
| 4 | [ChatProvider.tsx:854-856](../apps/web/src/pages/chat/ChatProvider.tsx#L854-L856) | `onDraft` replaces `drafts[conversationId]` unconditionally. It ignores the event's `at` field and never compares the echo with what is in the box. |
| 5 | React | The controlled textarea gets a new `value` and moves the caret to the end. |

**Timeline on a 2 s round trip (typical school Wi-Fi at peak, or 3G):**

```
t=0.0  types "I will come tomorow"            (pause)
t=0.8  PUT draft="I will come tomorow"        → in flight
t=1.2  sees the typo, presses Backspace ×3 → "I will come tomo"
t=1.6  types "rrow" → "I will come tomorrow"
t=2.8  echo arrives: draft="I will come tomorow"
       → box reverts to the typo, caret jumps to the end
t=2.9  keeps typing " at 9" → "I will come tomorow at 9"   (typo is back)
t=3.6  the second PUT's echo arrives later and flips the box again
```

**Worse cases that follow from the same code:**

- **Old echo arrives last.** Two PUTs in flight can arrive or be answered out of order. The older echo then wins for good, and the server also keeps the older draft.
- **A sent message comes back into the box.** Suppose the person pauses (PUT A with the full text starts) and then presses Send within the round trip. `send()` clears the draft, and a PUT with `''` follows 800 ms later. If A's echo arrives after the clear, **the message that was just sent reappears in the composer**. The person then deletes it or sends it twice.
- **Deleting is fought.** Holding Backspace on a slow line makes several PUTs, one per pause, and each echo puts characters back. People call this "hard to delete a character".
- **Two tabs or devices both apply each other's echo.** There is no "which is newer" rule.

**Fix (in order of value):**
1. **The sender ignores its own echo.** The client sends a per-tab id (for example an `X-Tupo-Tab` header). The server includes it in the event as `origin`, and the client drops events whose `origin` is its own tab. A simpler server-side option is to emit `.except(socketId)` when the request names its socket.
2. **Never overwrite a draft that is being edited.** Ignore a remote draft for a conversation whose composer has focus or was changed in the last few seconds. Show "Draft updated on another device. Use it?" instead.
3. **Newest wins.** Send the client's `savedAt` with the PUT. The server stores and echoes it, and both the server and `onDraft` reject anything older than what they already hold.
4. **Cancel or supersede requests that are still in flight.** Use an `AbortController` per conversation, so only the latest draft PUT is alive.
5. **Sending ends the draft.** On send, cancel the pending debounce timer and the in-flight PUT. Then ignore any echo whose text equals the text just sent.

### 2.2 Per-keystroke re-render of the whole chat (G-02, high)

- [ChatProvider.tsx:1536-1552](../apps/web/src/pages/chat/ChatProvider.tsx#L1536-L1552): `const value: ChatValue = { … }` is rebuilt on every render and is not memoised. Any state change, including **every keystroke** through `setDrafts`, gives every consumer a new value.
- 26 files call `useChat()`. The one that matters most is `MessageRow` ([MessageThread.tsx:228-231](../apps/web/src/pages/chat/MessageThread.tsx#L228-L231)): **each row subscribes to the context itself**. Wrapping rows in `React.memo` would not help, because a context change re-renders them anyway.
- Windowing only starts above 200 messages ([useVirtualWindow.ts](../apps/web/src/pages/chat/useVirtualWindow.ts), `THRESHOLD = 200`). So a normal conversation re-renders up to 200 rows per keystroke, each with rich text, reactions, gestures and permission hooks. The sidebar list and the header re-render as well.
- [Composer.tsx:134-139](../apps/web/src/pages/chat/Composer.tsx#L134-L139): the auto-grow effect sets `height = 'auto'` and then reads `scrollHeight` on every keystroke. That forces a synchronous layout on top of the re-render.
- This hurts most on the phones and older Chromebooks students actually use. On Android with Gboard or Samsung Keyboard, a slow commit during composition is a known cause of characters lost or doubled in controlled React inputs. That is the same "typo" symptom, even on a fast network.

**Fix:**
1. **Move the composer's text into local component state**, or make the textarea uncontrolled with a ref. Push it to the shared draft store debounced (about 300 ms) and on blur or conversation switch. Typing then re-renders only the composer.
2. **Split the context.** Use a stable actions context (memoised callbacks), plus separate contexts or `useSyncExternalStore` selectors for messages, conversations, typing, drafts and UI state. At minimum, wrap `value` in `useMemo`.
3. **Make `MessageRow` a pure `React.memo` component.** Read `useChat()` once in the thread and pass the stable callbacks plus per-row flags (`isEditing`, `isHighlighted`, `threadUnread`) as props.
4. **Auto-grow:** skip the measurement when the text has not wrapped, or use CSS `field-sizing: content` where it is supported, with the JS as the fallback.

---

## 3. All findings

Severity: **Critical** = text or messages are lost or corrupted · **High** = a broken or misleading experience on common paths · **Medium** = degraded under specific conditions · **Low** = polish.

| ID | Severity | Area | Finding |
|---|---|---|---|
| G-01 | Critical | Composer | Draft echo overwrites live typing; it can also put a sent message back in the box (§2.1). |
| G-02 | High | Composer, perf | Every keystroke re-renders the whole chat tree and up to 200 rows (§2.2). |
| G-03 | Critical | Thread reply | Text typed while a reply is sending is wiped. |
| G-04 | High | Edit | A failed edit throws the correction away with no message. |
| G-05 | High | Network | No timeout on any REST request or socket ack. |
| G-06 | High | IME | Enter during IME composition sends or saves a half-composed word. |
| G-07 | High | Thread reply | Replies are not optimistic and not in the outbox, so they fail offline. |
| G-08 | Medium | Edit | On a phone, Enter saves the edit; you cannot add a line. |
| G-09 | Medium | Drafts | Drafts live only in memory and on the server, so they are lost on an offline reload or a quick tab close. |
| G-10 | Medium | Outbox | Two flushes can run at once on reconnect. |
| G-11 | Medium | Typing indicator | "Typing…" stays for about 6 s after the text is cleared or the person leaves. |
| G-12 | Medium | Edit, delete | No "saving…" state; the delete is not optimistic, contrary to its comment. |
| G-13 | Medium | Pending messages | A message stays on the clock icon for as long as the socket is half-open. |
| G-14 | Low | Thread reply | No length limit or near-limit counter. |
| G-15 | Low | Drafts | One draft PUT per pause, each fanned out to all devices, which is wasteful on metered links. |
| G-16 | Low | Composer | The caret is lost when a remote update changes `value`, even when the text is the same. |

### G-03: Thread reply wipes text typed while sending (critical)

[ThreadPanel.tsx:159-174](../apps/web/src/pages/chat/ThreadPanel.tsx#L159-L174): `submit()` awaits `sendThreadReply(...)` and only then calls `setValue('')`. The textarea stays editable during the wait. On a 3–5 s round trip, someone who starts their next reply sees it **erased** when the first one is answered.

**Fix:** take the text out of the box *at send time*: snapshot the text, clear the box at once, and put it back only on failure (and only if the box is still empty). Better still, see G-07.

### G-04: A failed edit loses the correction without a message (high)

[MessageThread.tsx:336-341](../apps/web/src/pages/chat/MessageThread.tsx#L336-L341): `submitEdit` closes the editor first, then awaits `edit()`, and on failure does `catch { /* the row simply does not change */ }`. On a slow or dropped line, the person sees the old text for seconds. If the request fails, their rewrite is gone and nothing tells them.

This also breaks the team's own rule of a toast on every action outcome.

**Fix:**
- Show the new text right away (optimistic update) with a "saving" mark.
- On failure, restore the old text, reopen the editor with the attempted text, and show a toast with Retry.

### G-05: No timeouts on REST or socket acks (high)

- [lib/api.ts:37](../apps/web/src/lib/api.ts#L37): `fetch` has no `AbortSignal.timeout`. On a stalled mobile connection, draft saves, edits, thread replies and the outbox flush can hang for minutes before the browser gives up. Every "sending…" spinner hangs with them.
- [ChatProvider.tsx:1119-1124](../apps/web/src/pages/chat/ChatProvider.tsx#L1119-L1124): `socket.emit('message:send', payload, ack)` has no `.timeout()`. If the socket is half-open (it looks connected but is dead), the ack never comes. The message stays on the clock icon until Socket.IO's ping timeout (about 20–45 s) forces a reconnect and the outbox flush resends it.

**Fix:**
- Add a default timeout of 15–20 s to `request()`, configurable per call.
- Use `socket.timeout(8000).emit(...)`. On timeout, fall back to REST with the same nonce; the server already deduplicates by nonce.
- After about 3 s pending, show "Still sending…" on the bubble, so the person does not resend.

### G-06: IME composition is not handled (high)

There is no `isComposing` or `compositionstart` check anywhere in `apps/web/src`. In the composer ([Composer.tsx:313-368](../apps/web/src/pages/chat/Composer.tsx#L313-L368)), the thread box ([ThreadPanel.tsx:278](../apps/web/src/pages/chat/ThreadPanel.tsx#L278)) and the edit box ([MessageThread.tsx:402](../apps/web/src/pages/chat/MessageThread.tsx#L402)), Enter confirms the IME candidate **and** sends the message, or saves the edit.

This affects:
- people typing with any composition-based keyboard: Chinese, Japanese, Korean, and some Swahili or Kinyarwanda predictive layouts on tablets with a physical keyboard;
- dictation on desktop;
- the slash-command and mention pickers, which also take Arrow and Enter during composition.

**Fix:** guard every key handler with `if (e.nativeEvent.isComposing || e.keyCode === 229) return;`. Put it in one shared `useComposerKeys` helper so the three boxes cannot drift apart again.

### G-07: Thread replies are not optimistic and not durable (high)

[ChatProvider.tsx:1283-1295](../apps/web/src/pages/chat/ChatProvider.tsx#L1283-L1295): `sendThreadReply` is a plain REST call. There is no pending bubble, no outbox entry and no offline queue. The main composer has all three (FR-MSG-24). Offline, a thread reply just fails. On a slow line, nothing appears until the round trip ends.

**Fix:** route thread replies through the same `send()` path. It already accepts `threadRootId`, and the outbox already stores it.

### G-08: On a phone, Enter saves an edit (medium)

[MessageThread.tsx:402](../apps/web/src/pages/chat/MessageThread.tsx#L402) saves on Enter without the touch check the composer uses ([Composer.tsx:359](../apps/web/src/pages/chat/Composer.tsx#L359)). On a phone, you cannot add a line to an edit, and pressing the keyboard's return key saves a half-made correction.

The hint text "Enter to save" also shows on touch, where it is wrong.

**Fix:** use the same rule as the composer (touch: Enter inserts a newline, Save is a button), and hide the keyboard hint on touch.

### G-09: Drafts are not kept on the device (medium)

Drafts are held in React state and saved to the server 800 ms after a pause. They are not written to IndexedDB, unlike the conversation and message caches (`chat:conversations`, `chat:msgs:*`). There is no `pagehide` flush either. So:
- an offline reload loses the draft;
- closing the tab within 800 ms of the last keystroke loses the tail;
- thread drafts (`threadDrafts`, an in-memory Map) are lost on any reload.

**Fix:**
- Write drafts locally on every debounce, through the existing `debouncedWriter`, and treat the local copy as the authority.
- Sync to the server as a background copy for other devices.
- Flush on `pagehide` with `navigator.sendBeacon` or `fetch(..., { keepalive: true })`.

### G-10: Overlapping outbox flushes (medium)

`flushOutbox` runs from both `onConnect` ([ChatProvider.tsx:574](../apps/web/src/pages/chat/ChatProvider.tsx#L574)) and `window` `online` ([:962](../apps/web/src/pages/chat/ChatProvider.tsx#L962)). Coming back online usually fires both within a second, and nothing stops two flushes from running together.

The nonce prevents duplicate messages, but:
- each queued message is sent twice over the slow link that just recovered;
- `recordAttempt` counts failures twice, so an entry can reach `MAX_ATTEMPTS` (5) and be shown as failed after only 2–3 real tries.

**Fix:** keep a single-flight guard (a module-level promise) in `outbox.flush`, so a second call joins the flush already running.

### G-11: The typing indicator outlives the typing (medium)

`typing:stop` is sent only from `send()` ([ChatProvider.tsx:1038](../apps/web/src/pages/chat/ChatProvider.tsx#L1038)). Clearing the box, blurring it, switching conversation or closing the tab leaves "X is typing…" on the other side for the full TTL (6 s in the server key, plus about 7 s on the client). On a slow network it lasts even longer, because the indicator was refreshed by the last throttled `typing:start`.

**Fix:** emit `typing:stop` when the text becomes empty, on blur, on conversation change and on `pagehide`.

### G-12: Edit and delete give no feedback while waiting (medium)

- **Edit:** see G-04. Nothing shows while the request is in flight.
- **Delete:** [ChatProvider.tsx:1252-1261](../apps/web/src/pages/chat/ChatProvider.tsx#L1252-L1261) has a comment saying the row changes "on the click rather than on the echo", but the tombstone is applied *after* `await chatApi.deleteMessage`. On a slow line, the message sits there after the confirm dialog closes, and people press Delete again.

**Fix:** apply the tombstone first and restore the row on failure, as `pin` already does (P-04).

### G-13: The pending state never escalates (medium)

A pending message shows only a 12 px clock ([MessageThread.tsx:211](../apps/web/src/pages/chat/MessageThread.tsx#L211)) with no time-based escalation. Combined with G-05, a message can look like it is "sending" for 45 s. The offline banner does not appear either, because the socket still reports connected.

**Fix:**
- After about 3 s, show "Sending…".
- After about 15 s, show "Slow connection. Will keep trying".
- On failure, show the existing "Not sent — retry".

### G-14: Thread reply has no length limit (low)

The main composer refuses replies over `MAX_MESSAGE_LENGTH` (8,000) before sending and shows a counter near the limit (B-06). The thread box does neither, so a long reply fails only after the round trip.

**Fix:** share the limit check and the counter between the composer and the thread box.

### G-15: Draft traffic (low)

Every pause longer than 800 ms produces a PUT, a database write and a fan-out to all the user's sockets. A person writing a long message makes dozens of each. On metered student data, and on a shared school uplink, this is real cost for a feature (cross-device drafts) whose value is the last copy only.

**Fix:**
- Raise the server debounce to 2–3 s once local persistence (G-09) carries the short-term safety.
- Also save on blur and on conversation switch.
- Never echo to the originating tab (G-01).

### G-16: The caret jumps on any remote `value` change (low)

Even after G-01 is fixed, any other path that sets the active draft from outside the box resets the caret to the end:
- `refresh()` seeding a draft ([ChatProvider.tsx:353-359](../apps/web/src/pages/chat/ChatProvider.tsx#L353-L359));
- a cross-device draft that was accepted.

**Fix:** with the local-state composer (G-02 fix 1), apply external text only when the box is not focused. If it must be applied while focused, keep the selection where it is (`selectionStart`/`End`, clamped).

---

## 4. Things that are already right

These were checked and should be kept as the fixes go in:

- **Outbox design.** It writes to IndexedDB before sending, removes the entry only on ack, keeps the nonce for deduplication, sends in order, and stops at the first failure, with a give-up after 5 attempts.
- **Socket reconnect.** It reconnects by hand on `online`, spreads reconnects on deploys, re-subscribes rooms and catches up on reconnect.
- **Typing throttle.** `typing:start` is throttled to one every 3 s rather than once per keystroke.
- **Member list.** It is fetched once per conversation for the @ picker, not per keystroke.
- **Composer limits and uploads.** The length limit is checked before sending, and sending waits for uploads to finish instead of posting text without its attachments.

---

## 5. Recommended delivery order

| Batch | Items | Why first |
|---|---|---|
| **1. Stop corrupting text** (about 1 day) | G-01 (ignore own echo, newest wins, abort in-flight), G-03, G-06 | Ends the reported bug and the two other ways typed text is lost. Small, low-risk changes. |
| **2. Typing performance** (2–3 days) | G-02 (local composer state, memoised and split context, memoised rows), G-16 | Removes keystroke lag on low-end devices. Touches the provider shape, so it needs the full chat regression. |
| **3. Honest slow-network behaviour** (about 2 days) | G-05, G-13, G-04, G-12, G-07 | Every action either finishes, says it is slow, or fails with a retry. |
| **4. Durability and polish** (about 1 day) | G-09, G-10, G-11, G-08, G-14, G-15 | Drafts survive reloads, less traffic, correct indicators. |

---

## 6. Acceptance criteria

1. With Chrome DevTools throttled to **"Slow 3G" plus 2,000 ms of extra latency**, typing, deleting and correcting a 200-character message never changes text the person did not touch, and the caret never moves on its own.
2. Sending during an in-flight draft save never brings the sent text back into the composer.
3. On a mid-range Android phone (or 6× CPU throttling), the time from keystroke to paint stays **under 16 ms at the median and under 50 ms at p95** in a conversation with 200 loaded messages.
4. A thread reply, an edit or a delete that fails on the network keeps or restores what the person wrote, and says so in a toast with Retry.
5. Enter during IME composition never sends.
6. A reload while offline keeps the main and thread drafts.
7. Coming back online sends each queued message exactly once.

---

## 7. Verification plan

Add a `verify:composer:slow` Playwright suite that follows the pattern of the existing `verify:optimistic` and `verify:local-first` suites:

| Test | Covers |
|---|---|
| Route `PUT **/draft` with a 2 s delay. Type, pause 1 s, delete 3 characters, type 4 more. Assert the textarea value at t+4 s equals the final intended text. | G-01 |
| Same delay, then pause, Send, and wait 3 s. Assert the composer is empty and exactly one message exists. | G-01 |
| Two pages for the same user (two tabs). Typing in A while B is idle updates B's draft, and B never overwrites A. | G-01 |
| Delay thread `POST` by 3 s. Send, type "next", and assert "next" survives the response. | G-03 |
| Make the edit `PATCH` return 500. Assert a toast appears and the editor reopens with the attempted text. | G-04 |
| Dispatch `compositionstart`, then Enter with `isComposing: true`. Assert no send. | G-06 |
| React Profiler or `performance.measure` around input events with 200 messages. Assert MessageRow does not re-render on a keystroke. | G-02 |
| Go offline and send 3 messages. Fire `online` and `connect` together. Assert 3 POSTs, not 6. | G-10 |

The existing suites `verify:optimistic`, `verify:sync`, `verify:local-first` and `gap2-chat-journeys` must stay green after batch 2, because it changes the provider's shape.
