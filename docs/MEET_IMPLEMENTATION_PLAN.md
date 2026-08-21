# Tupo Meet — Phase 3 Implementation Plan

**Scope:** the whole of SRS §6.5 (`FR-MEET-1` … `FR-MEET-20`) and §10, plus an AI layer that
the SRS only gestures at (`FR-MEET-17`). Delivered on top of the Phase 0/0.5 skeleton.

**Governing constraints inherited from Phase 0:** no login of Tupo's own; permissions resolved
from the database on every request; the server is the only enforcer; ESM + `.js` relative
imports; npm workspaces.

---

## 1. Research summary — what "modern" means in August 2026

The features below were chosen after surveying what Google Meet, Zoom and Teams actually ship
today, and what the WebRTC stack can support. Each row records the decision Tupo takes.

| Area | State of the art (2026) | Tupo's decision |
|---|---|---|
| **Media routing** | SFU everywhere; mesh only for 1:1 | **Dual transport.** Mesh for ≤ `MEET_MESH_MAX` (default 4), Cloudflare Realtime above it and whenever it is configured. Mesh means Tupo works with zero media infrastructure — which is also what makes every feature testable on a laptop. |
| **NAT traversal** | TURN over TLS/443 mandatory on school networks | **Cloudflare Realtime TURN**, the same credentials TaskMentor's proctoring module uses. Short-lived credentials minted server-side, never shipped in a bundle. Google STUN as the no-credential fallback. |
| **Bitrate adaptation** | Simulcast is the default for VP8/H.264; SVC for VP9/AV1 in Chromium. AV1 is *not* broadly production-ready for two-way video — hardware encode is still thin | **Simulcast, 3 layers (180p/360p/720p)**, VP9 SVC opportunistically where `getCapabilities` reports it, AV1 **off** by default behind a flag. |
| **Uplink saving** | Dynacast — pause layers nobody subscribes to | Implemented on both transports: through the SFU by pulling only the tracks on screen, and on mesh by disabling unused simulcast encodings through `RTCRtpSender.setParameters()`. |
| **Downlink saving** | Adaptive stream — subscribe at the resolution the *tile* needs, and not at all when off-screen | `IntersectionObserver` + `ResizeObserver` per tile drives `setVideoQuality`/`setEnabled` (SFU) and receiver-side layer preference (mesh). Only the top-N active speakers render video at all; the rest are avatar + audio. |
| **Captions** | Hosted streaming STT with diarization; Whisper is batch-only and cannot diarize | **Speaker-attributed captions without a STT bill.** Each participant runs the browser's own `SpeechRecognition` on *their own* microphone and ships **text** over the socket. Diarization is free because we already know whose mic it is, the transcript is speaker-attributed by construction, and a caption costs ~80 bytes instead of an audio stream. A server-side Whisper path is left as a documented seam for languages the browser will not do. |
| **AI notetaking** | Gemini "Take notes for me", Copilot recap, Zoom AI Companion | **Tupo AI** joins as a real roster participant, consumes the speaker-attributed transcript, and produces live summary, decisions, action items, "catch me up", and post-meeting minutes through the **existing four-provider fallback chain** ported from TaskMentor. |
| **Large meetings** | Overflow attendees redirected to a stream, still able to react/chat/poll | **Webinar mode**: `MEET_VIDEO_CAP` publishers, everyone else audio + reactions + chat + polls + Q&A. |
| **Interaction** | Polls, Q&A, reactions, hand raise, breakouts | All shipped. Reactions are ephemeral (socket-only, never persisted); polls and Q&A are persisted so they survive a reload and land in the minutes. |

Sources consulted: Cloudflare Realtime SFU/TURN docs, SFU architecture comparisons and
limits, Google Workspace Meet AI announcements (Apr/Aug 2026), digitalsamba and bloggeek on
SVC-vs-simulcast, AssemblyAI on notetaker diarization gaps.

---

## 2. Architecture

```
  Browser                        tupo-api :5190              tupo-realtime :5191
  ───────                        ────────────                ───────────────────
  PreJoin ── GET /api/meet/:id/ice ──▶ Cloudflare TURN API
          ── POST /api/meet/:id/join ─▶ { transport, sfuEndpoint?, meeting }
                                                    │
  Room ─────────────── socket.io namespace /meet ───┴────────────────────▶
        roster · lobby knocks · host commands · hand · reactions · chat
        polls · Q&A · breakouts · captions · net-stats · MESH SIGNALLING
                                                    │
                                                    ├─▶ meeting_events   (severity-tagged,
                                                    │                     proctoring-shaped)
                                                    └─▶ meeting_transcript_segments
                                                                 │
   media ──┬── mesh:  N×(N−1) peer connections, Cloudflare TURN  │
           └── sfu:   Cloudflare Realtime, simulcast + adaptive  │
                                                                 ▼
                                                   tupo-worker  BullMQ
                                                   meet:minutes · meet:attendance
                                                   → AI provider chain
                                                     (openai→gemini→groq→glm)
```

**Why the transport is pluggable rather than SFU-only.** A media server is a heavy dependency
to put between a developer and *every* feature in the module — chat, polls, captions, AI, host controls and
attendance all work identically regardless of how the pixels move. Putting the media behind a
`MediaTransport` interface means the application layer is written once and verified once, and
`MEET_MEDIA_MODE` decides at runtime which implementation carries the video.

**Division of responsibility** (SRS §10.1, unchanged): the media layer owns ICE/DTLS/SRTP,
simulcast and bandwidth estimation. `tupo-realtime` owns *everything else* — who is in the
lobby, who is co-host, the hand-raise order, the chat, the captions. A media restart therefore
does not lose meeting state.

**Reuse of the proctoring model** (SRS §10.2) is literal, not aspirational:

| TaskMentor proctoring | Tupo Meet |
|---|---|
| `GET /turn-credentials` → Cloudflare | `GET /api/meet/ice` → same Cloudflare endpoint, same fallback |
| socket `join-room` / `offer` / `answer` / `ice-candidate` | `meet:mesh:*` events, same handshake |
| `proctoring_events` (type, severity, payload) | `meeting_events`, same three columns |
| `LiveProctoringDashboard` live tiles | Host console participant tiles |
| `ProctoringSettings` per quiz | `meetings.settings` JSONB per meeting |

---

## 3. Data model — migration `0004_meet.sql`

| Table | Purpose |
|---|---|
| `meetings` | Title, host, optional `conversation_id`, `room_name`, 9-char `join_code`, status, schedule, `settings` JSONB, `media_mode` |
| `meeting_participants` | Join/leave times, role (`host`/`cohost`/`presenter`/`attendee`), state, device, per-participant duration — the attendance record |
| `meeting_events` | Range-partitioned by month. `type`, `severity` (`info`/`warn`/`critical`), `payload` — the proctoring shape |
| `meeting_chat_messages` | In-meeting chat, persisted so it can be replayed and folded into the minutes |
| `meeting_transcript_segments` | `speaker_id`, `text`, `lang`, `started_at`, `is_final`, `confidence` — the speaker-attributed transcript |
| `meeting_ai_artifacts` | One row per generated artifact: `summary`, `minutes`, `action_items`, `decisions`, `chapters`, `qa_answer`, `title`, with `provider_used` |
| `meeting_polls` / `meeting_poll_votes` | Live polls and quizzes |
| `meeting_questions` | Q&A queue with upvotes and answered-state |
| `meeting_breakouts` / `meeting_breakout_members` | Rooms, timer, assignment |
| `meeting_recordings` | Recording rows pointing at `files` |
| `meeting_invites` | Invitee list for scheduled meetings, ICS/mail hand-off |

Partitioning follows `0002_message_partitions.sql`: three months pre-created, same helper.

---

## 4. Work breakdown

### Step 1 — `packages/shared`
`meet.ts`: transport/role/status enums, `MeetSettings` zod schema with defaults, media
constants (simulcast ladder, bitrate budget, mesh cap, degradation order). `events.ts`: the
complete `/meet` socket catalogue, typed both directions. Two new permissions —
`MEET_AI_USE`, `MEET_TRANSCRIBE` — appended to the catalogue (58 → 60) and granted to Staff,
Moderator and Admin.

### Step 2 — `packages/db`
`0004_meet.sql` + Drizzle table definitions + seed additions.

### Step 3 — `apps/api`
- `services/aiProviders/*` — the four providers ported from TaskMentor, ESM, with the cooldown
  circuit breaker intact.
- `services/turnService.ts` — Cloudflare credential minting, 5-minute in-process cache
  (credentials are 24 h TTL; there is no reason to hit the API per join).
- `services/cloudflareSfuService.ts` — the Realtime SFU client, guarded so an unconfigured
  media server degrades to mesh instead of throwing, and treating an `errorCode` inside a 200
  as the failure it is.
- `services/meetService.ts` — creation, join authorization, lobby policy, attendance rollup.
- `services/meetAiService.ts` — the prompts: live summary, minutes, action items, decisions,
  chapters, Q&A over transcript, auto-title, engagement report, translation.
- `routes/meet.ts` — ~30 endpoints, every one behind `authorizePermission`.

### Step 4 — `apps/realtime`
`meet/namespace.ts` — the `/meet` namespace: room lifecycle, lobby, roster with Redis-backed
state so several gateway instances agree, host commands, hand/reactions, chat, polls, Q&A,
captions ingest with batched persistence, breakouts, and the mesh signalling relay.

### Step 5 — `apps/worker`
`jobs/meetMinutes.ts` — post-meeting minutes, action items, chapters, auto-title.
`jobs/meetAttendance.ts` — close open participant rows, compute durations, emit the summary.

### Step 6 — `apps/web` — `src/pages/meet/`
| File | What it is |
|---|---|
| `MeetHome.tsx` | Start instant · join by code · upcoming · past meetings with AI recaps |
| `Scheduler.tsx` | Title, time, recurrence, invitees, settings |
| `PreJoin.tsx` | `FR-MEET-4` — camera preview, live mic meter, speaker test, device pickers, background blur, join-muted |
| `MeetingRoom.tsx` | The room: layouts, stage, control bar, side panels |
| `useMeetRoom.ts` | The room state machine and socket wiring |
| `transport/` | `MediaTransport` interface, `MeshTransport`, `CloudflareTransport` |
| `Stage.tsx` / `Tile.tsx` | Grid · speaker · sidebar layouts, pin/spotlight, adaptive subscription |
| `ControlBar.tsx` | Mic/cam/share/hand/react/captions/AI/leave, with device menus |
| `panels/` | Participants · Chat · Captions · AI · Polls · Q&A · Breakouts · Settings |
| `HostConsole.tsx` | The proctoring-dashboard analogue |
| `MeetingSummary.tsx` | Post-meeting: attendance, transcript, minutes, action items, export |

### Step 7 — infra & docs
docker-compose for the data stores only — the media server is an API call, not a container —
nginx websocket notes, `.env.example` for every app.

---

## 5. AI feature set

Every one of these runs through the ported provider chain, so a quota failure on OpenAI silently
falls through to Gemini, then Groq, then GLM.

| Feature | When | How |
|---|---|---|
| **Tupo AI notetaker** | Host invites it; a visible roster tile and a consent banner | Consumes the live transcript |
| **Live summary** | Every `MEET_AI_INTERVAL` (default 90 s) of new transcript | Rolling structured summary |
| **Catch me up** | On demand, for anyone joining late | "What have I missed?" over transcript-so-far |
| **Action items** | Live + final | `{ text, owner, due, confidence }`, owner matched against the roster |
| **Decisions log** | Live + final | Structured decisions with the quote that supports each |
| **Post-meeting minutes** | On `meeting.ended` | Agenda, discussion, decisions, actions, next steps |
| **Auto chapters** | On end | Timestamped topic segments, linked to the recording |
| **Auto title** | On end, when the host left it blank | One line from the transcript |
| **Ask the meeting** | Any time, live or after | RAG-lite Q&A over transcript + chat |
| **Live translation** | Per viewer | Caption segments translated to the viewer's language |
| **Engagement report** | On end | Talk-time distribution, participation balance, silent participants — for lesson-delivery evidence |
| **Lesson follow-up** | On end, class meetings | Suggested revision points and quiz questions, exportable to TaskMentor |
| **Smart agenda** | Before | Agenda from the meeting title, description and originating conversation |

**Safeguards.** AI is off unless the host turns it on; a persistent banner names it while it
runs; every artifact records `provider_used`; transcripts inherit the meeting's retention; and
`MEET_AI_USE` is a permission Students do not hold.

---

## 6. Verification plan

| # | Check | Method |
|---|---|---|
| M1 | Every workspace type-checks and builds | `npm run typecheck`, `npm run build` |
| M2 | `0004_meet.sql` applies to a clean DB and is idempotent | migrate twice |
| M3 | The 60-permission catalogue seeds, and the two new keys land on the right roles | `npm test` |
| M4 | Meeting CRUD, join codes, lobby policy, host authorization | supertest suite |
| M5 | A student cannot start, record, or use AI | supertest 403 assertions |
| M6 | Cloudflare TURN credentials are really minted | live call against `rtc.live.cloudflare.com` |
| M7 | The SFU endpoint is issued only to an admitted participant; absent config degrades to mesh | unit test |
| M8 | Two sockets join a meeting, see each other, and exchange mesh SDP | socket.io client script |
| M9 | Lobby knock → host admit → active | same script |
| M10 | Host commands land: mute, remove, lock, promote | same script |
| M11 | Captions ingest, persist speaker-attributed, and fan out | same script |
| M12 | The AI chain produces a summary from a seeded transcript | live call, all four providers |
| M13 | Post-meeting minutes job runs end to end | enqueue and assert |
| M14 | Attendance export is correct and downloadable as CSV | supertest |
| M15 | The UI renders and drives a real two-participant call | browser, two contexts |

---

## 7. Risks

| Risk | Mitigation |
|---|---|
| No media server in dev | Mesh transport is the default below the cap; Cloudflare is enabled by two env vars, with nothing to run |
| Mesh does not scale | Hard-capped at `MEET_MESH_MAX`; the API refuses mesh above it and says why |
| `SpeechRecognition` is Chromium-only | Feature-detected; captions degrade to off, and the AI panel says which participants are contributing transcript |
| AI cost/quota | Four-provider fallback with cooldown; AI off by default; interval-batched rather than per-utterance |
| Transcript privacy | Off by default, host-enabled, banner while running, retention inherited, permission-gated |

---

## 8. Status — 20 August 2026

Phase 3 is complete. Every `FR-MEET` requirement in SRS §6.5 is implemented, plus
an AI layer the SRS only listed as a "could" (`FR-MEET-17`).

### Verification results

| Check | Result |
|---|---|
| M1 typecheck + build, 7 workspaces | ✅ clean; web bundle **161 kB gzipped** main (the 138 kB SFU-SDK chunk was removed in round five — see §12) |
| M2 `0004_meet.sql` on a clean database | ✅ 17 tables, 3 monthly `meeting_events` partitions, idempotent on re-run |
| M3 permission catalogue | ✅ 58 → **60**; `MEET_TRANSCRIBE` and `MEET_AI_USE` land on Staff, Moderator and Admin only |
| M4 meeting CRUD, codes, lobby, host authority | ✅ covered by 73 new unit/integration tests |
| M5 a student cannot start, record, transcribe or use AI | ✅ 403 asserted on each |
| M6 Cloudflare TURN | ✅ live credentials minted; TCP/TLS fallback present |
| M7 SFU endpoint issuance | ✅ withheld from a participant still in the lobby; absent config degrades to mesh |
| M8 two sockets, roster, mesh SDP relay | ✅ |
| M9 lobby knock → admit → active | ✅ |
| M10 host commands | ✅ mute, mute-all, remove, promote, lock, spotlight; attendee refused |
| M11 speaker-attributed captions | ✅ 11 segments persisted with offsets and correct speakers |
| M12 the AI chain | ✅ summary, action items, decisions, Q&A, minutes, engagement, lesson follow-up — all via `gemini` after `openai` |
| M13 post-meeting wrap-up job | ✅ worker produced minutes, chapters and action items unprompted |
| M14 attendance export | ✅ CSV with formula-injection guarded cells; ICS with CRLF |
| M15 a real two-participant call in a browser | ✅ 26 checks, live peer-to-peer video both ways, 0 console errors |
| Extra — `npm audit` | ✅ 0 vulnerabilities |
| Extra — Phase 0 regression | ✅ 8/8 unchanged |

**Total: 120 automated tests + 64 runtime checks + 26 browser checks.**

Reproduce with:

```bash
npm test                 # 120 unit + integration
npm run dev              # then, against the live stack:
npm run verify:meet      # 64 runtime checks, incl. real TURN and real AI calls
npm run verify:meet:ui   # 26 browser checks, two participants (needs Playwright)
```

### Bugs this work surfaced

Recorded because each was silent — the call connected, the roster was right, and
something was quietly wrong anyway.

| Finding | Impact | Resolution |
|---|---|---|
| **The room hook read the local stream only from its lazy initial state.** The pre-join screen hands the stream over on a *later* render than the one that initialises the hook, so the ref stayed null, the transport connected with no tracks, and every tile in the meeting was an avatar. The call otherwise worked perfectly — roster, chat, hand-raise — which is what made it hard to see. | No video, ever | An effect adopts the stream when it arrives, and the transport waits for it rather than racing it. Caught only by the browser test. |
| **The worker's service token was re-signed from an already-signed payload.** `jsonwebtoken` refuses `expiresIn` when the payload already carries `exp`, so every post-meeting wrap-up failed to enqueue — and the failure was swallowed by the fail-soft enqueue, which is exactly what fail-soft is supposed to do. | No minutes were ever generated | Registered claims are stripped before re-signing, and only session claims travel to the worker. |
| **`POST /meet/instant` spread its defaults *over* the caller's settings** rather than under them, so an explicit `lobbyEnabled: true` was silently discarded. | Waiting room could not be turned on for an instant call | Defaults moved before the spread. |
| **AI preflight reported "AI is not configured on this server"** for a meeting that had simply never switched the notetaker on. | The wrong problem, pointed at the wrong person | Checks reordered: meeting settings and transcript volume first, deployment configuration last. |
| **The tile had no height**, so it sized to its content in the speaker, sidebar and spotlight layouts and left half the stage empty. The grid layout's `auto-rows-fr` masked it. | Broken layouts, but only after switching | `h-full w-full` on the tile root. |
| **Attendance rounded to whole minutes**, reporting "0 min" for anyone present under thirty seconds — which reads as *did not attend*. | A lesson record that misstates attendance | Short stays are reported in seconds. |
| **`livekit-client` was statically imported for its enums**, which pulled 531 kB into the main bundle and defeated the code splitting the mesh path exists to preserve. | Bundle 290 kB → over budget | Every import in that file was made a type import; the enums were read off the dynamic `import()` namespace. Moot since round five — the dependency is gone (§12). |

---

## 9. Round two — notes, access control, presenting, and the mini-call

Five features added after the first round, on request.

### 9.1 Notes — AI-assisted, never AI-owned

Separate table, separate lifecycle from `meeting_ai_artifacts`, and the reason
matters: an artifact is regenerated on demand, a note is not. Someone's own
record of a meeting must never be overwritten by the next summary run, which is
exactly what would happen if they shared a table.

| Action | What it does |
|---|---|
| **Write** | Type a note. Timestamped against the meeting, private by default. |
| **Capture** | One tap saves the last 45 s of transcript. This is the feature that makes manual note-taking survive a live meeting — the moment worth writing down has always just passed, and by the time you have typed it you have missed the next one. |
| **Tidy** | The AI fixes spelling and half-finished words **without changing meaning or adding anything**. The pre-AI text is kept on the row, so it is always reversible. |
| **Share** | Fans out over the socket and lands in the meeting's record. Private until you choose. |

Verified live: `chlorophyl reflects grn light - check spelling l8r` →
`Chlorophyll reflects green light - check spelling later.`

### 9.2 Who can join — four levels

`admissionPolicy` decides *eligibility*; the lobby decides *timing*. Separate on
purpose — "anyone in the school may attend, but I want to see them arrive" is an
ordinary thing to want, and one combined setting cannot express it.

| Policy | Admits |
|---|---|
| `permission` | Anyone whose role holds `MEET_JOIN`. The default. |
| `invited` | Only invitees and members of the originating conversation. A forwarded link is useless. |
| `authenticated` | Any signed-in user, **including those without `MEET_JOIN`** — that is the point, for assemblies and briefings. |
| `public` | Anyone with the link, including people with no NGA account. |

**Guests do not break "Tupo has no login of its own."** A guest ticket
authenticates *a participant row in one meeting*, not a person: no `users` row,
one permission (`MEET_JOIN`), expires with the meeting, and it can only be
minted for a meeting a host explicitly made public. It is a cinema ticket, not
an account. `POST /api/meet/:code/guest` is the only unauthenticated route in
Tupo, per-IP rate limited, and a non-public meeting returns 404 rather than 403
so codes cannot be probed.

### 9.3 Presenting

Rebuilt rather than patched. Camera and screen are now **separate streams**
bound by an announced `screenStreamId`, not told apart by counting tracks; the
share is letterboxed (`object-contain`) because cropping a slide removes exactly
the part being pointed at; the layout switches itself when someone starts, but
never overrides a layout the user picked by hand; a source picker offers
screen / window / tab plus audio *before* the browser's own dialog; and a
persistent "You are presenting" bar with a self-view means nobody discovers
they were sharing the wrong window twenty minutes later.

### 9.4 The mini-call

The active call is now owned by `MeetCallProvider`, mounted **above** `<Routes>`.
React Router unmounts a route component when you leave it, and unmounting the
meeting would close the peer connections — so someone who nipped into Chat would
come back to a dead room. Holding it above the router means the socket, the
transport and the media all outlive the route.

Portalled to `document.body` (the app shell clips its panes), draggable by
pointer events, snapping to the nearest **corner** — position is stored as a
corner offset rather than x/y, so it survives a window resize. Mic, camera,
present and leave all stay live. Signed-in users only: a guest has no other
pages to float it over.

### 9.5 Chat threads

One conversation per person plus the room, with unread badges — not a single
feed with a "send to" dropdown. The wire format is unchanged; a private message
still only ever reaches its two ends. This is purely how it is presented, and it
is the difference between private chat being usable and being technically
present.

### Verification

**123 automated tests · 107 runtime checks · 46 browser checks.**

### Bugs this round surfaced

| Finding | Impact | Resolution |
|---|---|---|
| **Mesh video was completely dead.** Both ends reported `connected`, tiles showed a frozen first frame, and every existing check passed. `ensurePeer` adds local tracks, which fires `negotiationneeded`, which offers — *on top of* an explicit offer, from both sides at once. Guaranteed glare on every single connection. | No video in any peer-to-peer meeting | Rewritten to the WebRTC spec's perfect-negotiation pattern: politeness derived by comparing participant ids (so the two ends always disagree, whichever connected first), argument-less `setLocalDescription()` so nothing can change state mid-await, and implicit rollback instead of a hand-rolled one. |
| **The check that should have caught it was too weak.** It asserted a stream was attached, which is true of a track receiving nothing. | A dead call passed as healthy | The check now measures **inbound bytes over a two-second window**. `track.muted` was tried first and is a trap: Chromium sets it whenever a page is backgrounded, which in a two-context test is always one of them. |
| **A guest could skip the lobby.** `admissionPolicy: 'public'` combined with `lobbyEnabled: false` — two settings a host could easily combine by accident — admitted anonymous strangers with no host ever seeing them. | Safeguarding | The guest check now precedes the lobby-disabled shortcut. A guest *always* knocks. |
| **The mini-call's own buttons did not work.** The whole title bar was the drag handle, so pointer capture swallowed every click on expand and collapse. | Could not return to the meeting | Drag ignores pointerdown originating in a button. |
| **The mini-call never showed video.** Its `<video>` only exists once the mini is on screen, which is *after* the stream is known — so an effect keyed on the stream ran once against a null ref and never again. | Black mini window | Bound by callback ref, which fires whenever the element appears. |
| **Minimising went silent.** Audio was played by each `Tile`, and tiles unmount when you navigate away. | Could not hear a call you were still in | Playback moved to `MeetAudioSink`, mounted by the provider and outliving every route. Video stays with the tiles — an undisplayed video element is wasted decode. |
| **Returning to the meeting showed the pre-join screen** while the meeting re-fetched, and tried to reopen the camera the call was already holding. | Visible flash, second permission prompt | The active call is matched against the URL as well as the loaded meeting. |
| **The poll toast sat on top of the chat composer's send button.** | Could not send a message with a poll open | Shifts clear of an open panel. |

---

## 10. Round three — motion, notifications, recording, naming, audiences, deletion

### 10.1 Motion

A meeting is the one screen in Tupo where things appear and disappear
constantly. Motion here is not decoration — it is what makes a change legible
instead of a sudden reflow you have to re-read. Tiles scale in, panels slide,
reactions float and fade, hands wave three times and stop, the speaking ring
pulses *slowly* (a fast pulse on the active speaker is the most distracting
thing a video UI can do), and the mini-call springs.

Every duration is under 260 ms: anything longer in a live call reads as lag,
because the user is already waiting on the network. `prefers-reduced-motion`
collapses durations to nothing rather than setting `animation: none`, which
would leave every `opacity: 0` start state invisible for ever.

### 10.2 Notifications — toast, sound, voice, system

Four channels, chosen by where the person is looking.

| Channel | When |
|---|---|
| **Toast** | On the page. Progress bar, hover to hold, emoji badge, one-tap action. |
| **Sound** | Always, unless muted. Synthesised from Web Audio — no files to download, cache-bust or license. Rising intervals mean *arrived*, falling means *left*, and the whole vocabulary is C-major so two cues landing together are still consonant. |
| **Voice** | Opt-in. `speechSynthesis` reads the handful of events worth knowing without looking — someone waiting, a hand up, recording starting. Off by default; a browser that starts talking unbidden is one people close. |
| **System** | Only when `document.hidden`. Firing one over a visible toast is how people learn to disable them. |

**Confirmations are a separate thing from notifications**, and the distinction
is load-bearing: a notification tells you something you did not know, a
confirmation closes a loop you opened. Sending a message, posting a poll,
voting, raising a hand, sharing a note, every host command — each gets a quiet,
short acknowledgement that is never spoken and never raised to the system,
because you were looking at the screen when you pressed the button. Muting and
reactions get none: they already announce themselves visually.

### 10.3 Recording, with a directory per meeting

Recording used to simply refuse without a media server. It is now always made
in the host's browser — Cloudflare Realtime routes tracks and does not
composite them, so there is nowhere on the server with a picture of the meeting
to record (see §12): the stage is drawn onto a canvas each
frame in the same layout the live stage uses, every participant's audio is
mixed through one `AudioContext`, and `MediaRecorder` writes VP9/Opus. The
result uploads to `meetings/<meetingId>/` so a meeting's media sits together
and can be exported or purged as a unit.

The limits are stated rather than hidden: it records what the host could see,
and it stops if the host leaves. The `mode` column records which path produced
each recording, because anyone reading one back needs to know.

### 10.4 Names, audiences, deletion

**Every meeting is proposed a name** built from the date and time — a list of
eleven rows all called "Meeting" is unusable — and it is editable in the
scheduler, in the room header, and afterwards.

**The audience is chosen as a category, not a rule**: Private (with an inline
people search), Anyone signed in, or Public. Each maps onto an
`admissionPolicy` the server enforces. Choosing Private reveals the search in
place rather than on a second screen, because "who?" is part of the same
decision as "how private?" — splitting them is how invite lists end up empty.

**Deleting belongs to the creator alone** — not a co-host, not an administrator.
It destroys the attendance record, the transcript and every note, and that is
not a decision to hand to everyone who can run the session; they have *end* and
*cancel*. It is audit-logged before the rows describing it disappear.

### Verification

**151 automated tests · 126 runtime checks · 64 browser checks.**

### Bugs this round surfaced

| Finding | Impact | Resolution |
|---|---|---|
| **`isDefaultMeetingName` assumed a locale.** It anchored on a digit after the separator, but `toLocaleDateString` puts the month first in en-US ("Aug 21") and the day first in en-GB ("21 Aug") — so it worked in exactly half the world, and the AI would never rename an untouched meeting for the other half. | Silent, locale-dependent | Matched on the separator instead. |
| **Deleting a meeting left its event stream behind.** `meeting_events` is range-partitioned and therefore carries no foreign key, so nothing cascaded to it. | "Deleted" meetings kept their audit trail of participants | Deleted explicitly, with the reason recorded next to it. |
| **New `files` rows broke every other test suite.** `files.owner_id` references `users` without a cascade, so the recording tests' fixtures made `DELETE FROM users` fail three suites away from the cause. | 38 failures with a misleading error | The Meet suite cleans up `files` before and after itself. |
| **The toast stack landed on top of the side panel** it was telling you to open. | Could not read or click the panel header | A `--tupo-toast-right` variable the room sets while a panel is open — a variable rather than a prop, because the stack renders in a portal far from that state. |
| **A toast that expires while being read.** | The commonest complaint about toasts | Hovering pauses the progress bar. |


---

## 11. Round four — Cloudflare Realtime as the media server

A self-hosted SFU is a *server you have to run*: a container, a UDP port range
50000–60000, a TURN companion and somewhere to put all three. This deployment
is not using Docker, so that path was a permanent "not yet" — which is why
meetings were still capped at four people.

**Cloudflare Realtime SFU replaces it.** Same job, no infrastructure: it is an
HTTP API on the account that already provides Meet's TURN, and TURN is free
when used alongside it.

### How it fits

Cloudflare's SFU has **no concept of a room**. It is a pub/sub of *sessions*
(one PeerConnection each) and *tracks*, and the application decides who
subscribes to what. For an app with no state that is a burden; for this one it
is a good fit, because `tupo-realtime` already owns the roster, the lobby and
the permissions. All the SFU has to do is move packets.

Two consequences shaped the implementation:

- **Track names are derived, not exchanged.** `cam-<participantId>`,
  `mic-<…>`, `screen-<…>`. Knowing who is in the meeting is enough to know what
  their tracks are called, which removes a round of signalling and a class of
  bug where publisher and subscriber disagree. The only thing that travels is
  each publisher's session id, and it rides on the roster.
- **Subscription is demand-driven.** The roster may hold four hundred people
  while the stage renders twenty-five. `setSubscriptions` pulls tracks for the
  tiles actually on screen and closes the rest with `force` (no renegotiation).
  Audio is pulled for *everyone* publishing — a hundred simultaneous voices is
  not a real scenario, and not hearing someone because their tile scrolled off
  is a much worse one.

### Capacity

Capacity is now a function of the transport, because the constraint is
different in kind. Peer-to-peer is bounded by every publisher's **uplink**,
which grows with the room. Through an SFU each publisher uploads once however
large the audience, and the bound moves to each subscriber's **downlink** —
already handled by rendering at most 25 tiles and subscribing to nothing else.

| Transport | Video | Audio-only |
|---|---|---|
| mesh | 4 | 4 |
| **cloudflare** | **500** | **2,000** |

So a 400-person assembly costs one uplink each and 25 downlinks, not 400.

### Security

The app secret stays in the API process. Every call the browser needs is
proxied through `/api/meet/:id/sfu`, and each is authorised against the meeting
before it is forwarded:

- only an **active** participant may open a session — someone still in the
  lobby has a row and a socket, and must not be able to open media;
- a subscriber may only pull tracks whose session is a participant **in this
  meeting**;
- and whose **track name belongs to that participant** — checking the session
  alone would let a caller fish for another participant's media using a session
  legitimately in the room;
- at most 64 tracks per call, matching Cloudflare's own limit.

A client holding that secret could create sessions on the account's bill and
subscribe to any track in any meeting on it.

### Verification

**184 automated tests · 136 runtime checks · 65 browser checks**, the last of
these now running two real participants through Cloudflare end to end.

The Cloudflare protocol layer is covered against a stubbed Cloudflare, since
credentials are a deployment concern. The runtime suite performs a **real**
session round trip and skips honestly when the app is not configured.

### Live since

App `tupo-meet` (`03751842…fa2f`) is configured and verified: real Cloudflare
sessions, real media between two browsers, **+168 kB in 2 s** measured on the
receiver. Every meeting is now placed on `cloudflare`.

### Findings

| Finding | Detail |
|---|---|
| **Nobody subscribed to anybody on first view.** Tiles report their size as they mount, which is *before* the transport has finished connecting — opening a media session is several round trips. Those early reports reached a null transport and were lost, and nothing reported again because nothing about the layout had changed. The connection was up, the roster was right, and no video ever arrived. Fixed by replaying the last reported visibility once the transport is live. |
| **A new publisher never triggered a re-subscribe.** Subscription is driven by two independent things — which tiles are on screen, and who is publishing — but only the first of them reported. Someone who started publishing after their tile appeared was never pulled. |
| **A blinking tile tore its subscription down.** A tile reports width 0 for a moment on any layout change; closing on the first such report and re-pulling a moment later cost a visible flicker, a fresh renegotiation and a new mid every time. A four-second grace period removes the churn entirely. |
| **Negotiation left the connection in `have-remote-offer`.** `createAnswer()` then `setLocalDescription(answer)` leaves an await between the two. The media just negotiated still flowed, so it looked fine — but every *later* renegotiation on that connection fails, so a third participant or a screen share would silently produce nothing. Argument-less `setLocalDescription()` makes it one step. |
| **The unit suite depended on the developer's `.env`.** Nine tests passed only while Cloudflare was unconfigured, and broke the moment real credentials were added. Media-server configuration is a deployment fact; the tests are about behaviour, so each now switches one on explicitly. |
| **The TURN credentials are not an SFU app.** Confirmed against the live API: `POST /v1/apps/<turnTokenId>/sessions/new` returns `not_found`. They are separate resources under Realtime, so an SFU app has to be created and its two values pasted in. | Documented in `.env.example` with the exact dashboard path |
| **Cloudflare reports per-request failures inside a 200 response**, in an `errorCode` field. Reading such a body as success is exactly how a broken call becomes a silent one. | Checked explicitly, with a test |
| **A 401 from Cloudflare means *our* secret is wrong, not the user's session.** Passing that status through would tell the user to sign in again, which cannot help. | Mapped to 502 |
| **"This meeting is full (4 participants)" told nobody anything they could act on.** The reason the cap is four is that no media server is configured. | The refusal now names the two variables that lift it |

---

## 12. Round five — removing LiveKit

With Cloudflare Realtime configured and verified, LiveKit was dead code that
still had to be maintained, typechecked, shipped and reasoned about. It was
removed entirely.

**Why nothing is lost.** Cloudflare carries strictly more than LiveKit did —
500 with video and 2,000 audio-only against 100/300 — on infrastructure that
already exists, and it needs no container, no UDP port range and no TURN
companion. Keeping a second SFU only for a deployment that might one day prefer
to self-host meant carrying two media paths, of which one was never exercised:
the transport branch, the token minting, the grant model, and a 531 kB
(137.5 kB gzipped) client SDK.

**What went.** `livekitService.ts` · `transport/livekit.ts` · the
`livekit-client` dependency · `infra/livekit/` and its compose service ·
`LIVEKIT_URL` / `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` · the `'sfu'` member
of `MEET_TRANSPORTS` and `MEET_MEDIA_MODES` · `livekitToken` / `livekitUrl` on
the join ticket · the LiveKit token test block.

**Two things it forced into the open.**

- **Recording was broken, not merely limited.** The room asked for *server-side*
  recording whenever `capabilities.sfu` was true — which Cloudflare makes true —
  and the API then refused it, because server-side recording was a LiveKit
  Egress job. So enabling the media server silently disabled recording. It is
  now unambiguous: Cloudflare Realtime routes tracks and does not composite
  them, so there is no server anywhere with a picture of the meeting, and
  recording is always made in the host's browser. `RECORDING_MODES` keeps
  `'server'` only so rows written before this parse; nothing produces one.
- **`mediaMode: 'sfu'` is kept as a legacy alias.** It used to name the
  self-hosted server; it now resolves to Cloudflare. A meeting configured
  before the switch opens rather than erroring on a value that no longer
  exists. (No such row exists in this database — this is belt and braces.)

The SRS keeps LiveKit in §2.2, §5.3 and its bibliography, as the *rejected*
alternative. That is what a decision record is for.

### Verified after the removal

| Check | Result |
|---|---|
| Typecheck, 7 workspaces | ✅ clean |
| Unit + integration | ✅ **188 passed** (179 API · 6 Cloudflare protocol · 3 shared) |
| Runtime, against the live stack | ✅ 126 passed, 2 skipped, 7 failed — **all seven are AI provider quota** (the same checks passed via groq and glm earlier the same day, before the daily caps ran out); every media-server, join, recording and host check green |
| Browser, two participants on Cloudflare | ✅ **65 passed**, `connected/connected/stable` both sides, host=2 pupil=2 tiles, media measured as arriving bytes |
| Recording with the media server on | ✅ `sfu=true → 200: client` — the case that was broken |
| Web bundle | ✅ single chunk, **182 kB gzipped**, no SFU SDK — the 137.5 kB `livekit-client` chunk is gone |
| `npm audit` | ✅ 0 vulnerabilities |

---

## 13. Round six — the interface

Meet is the one part of Tupo that runs full-bleed and dark for an hour at a
time, so it earns a richer vocabulary than a page of tables. The work was to
give it one, as *utilities* rather than per-component styling — `index.css`
gained `tupo-glass`, `tupo-sheen`, `tupo-lift`, `tupo-press`,
`tupo-gradient-accent`, `tupo-aurora` and `tupo-live-dot`, and every screen
below is composed from those. Nothing here hard-codes a component, and the
existing `prefers-reduced-motion` rule collapses all of it to a single frame.

**What changed, and why that thing specifically.**

| Screen | The problem | The change |
|---|---|---|
| Home | Flat. Two grey cards, and three identical rows for three identical "Instant meeting" entries — nothing said which one you could walk into. | Aurora field behind the page, gradient wordmark, gradient icon chip on the primary card. Live meetings get a warm border, a tinted ground and a pulsing presence dot; every row lifts on hover and slides in a chevron, and the join code is chipped so it reads as data rather than as chrome. |
| Pre-join | Three **native `<select>`s** with the OS arrow — by some distance the most dated thing in the module. A flat 1.5px level bar that sits near the left edge at normal speaking volume and reads as broken. | The selects stay native — they are the accessible, mobile-correct control and the popup belongs to the OS — but `appearance-none` kills the OS chrome and the arrow is drawn as a chevron. The whole panel became glass over an aurora ground, the meter became twelve segments with the top two amber for the clipping range, and the controls grew to 48px with a felt press. |
| Room | A bare row of circles on a dark strip; a flat "Cloudflare" label that read as branding. | The centre controls became a floating glass pill; the active state is the accent gradient rather than a flat blue; the header is a gradient wash with the join code chipped and the transport pill carrying a green indicator, so "Cloudflare" reads as a working connection. |
| Mini call · panels · full-screen states | Each had its own hand-rolled dark surface. | All three now compose `tupo-glass`, so a panel sliding over the stage and the mini window that survives navigation are visibly the same material. |

### The bug the redesign flushed out

The layout change moved a tile to within a few pixels of the 640px simulcast
boundary, and the browser suite went from `+168 kB` of video to **`+0 bytes in
2s`** — twice, then passed, then failed again.

`qualityForWidth` mapped width to rung with no hysteresis. A tile resting on a
boundary — which is not exotic, it is what a two-up grid at a common window
size produces — flipped between `medium` and `high` on every layout settle, and
**every flip is a real unsubscribe and re-subscribe against the SFU**. The
stream was torn down and rebuilt continuously, so almost no video arrived.

Stepping *up* is still immediate: arriving at a bigger tile should sharpen at
once, and it cannot oscillate because the step *down* is the half that is
damped — a rung is only given up once the tile has fallen 12% clear of the
boundary it is leaving.

The function moved to `@tupo/shared` in the process. The rung ladder is part of
the media contract rather than a detail of one transport, and it is now covered
by 11 tests that pin exactly the case that failed (`qualityForWidth(639,
'high') === 'high'`).

### One harness fix

`the call was never interrupted` asserted that two videos were painting a fixed
800ms after returning from the mini window. Returning remounts both tiles, and
a `<video>` reads back `videoWidth === 0` until it has decoded a frame into the
new element — so the assertion was testing the machine's speed, not the call's
survival. It now waits for the condition with a 10s ceiling. It still fails if
the video genuinely never returns; it just no longer races it.

### Verified

Typecheck clean · **196 tests** (179 API · 14 shared · 3 db) · **66/66 browser
checks**, media confirmed by measured inbound bytes · build clean · CSS 16.3 kB
gzipped (+1.4 kB for the whole surface language).
