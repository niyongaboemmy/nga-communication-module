# Tupo — Unified Communication Platform
## Software Requirements Specification (SRS)

| Field | Value |
|---|---|
| **Product name** | Tupo |
| **Product family** | NGA Digital Ecosystem (NGA Central MIS · TaskMentor · Discipline & Attendance · **Tupo**) |
| **Repository** | `nga-communication-module` |
| **Document version** | 1.0 (Draft for approval) |
| **Date** | 19 August 2026 |
| **Status** | Requirements baseline — pending sign-off |
| **Author** | Project Management & Systems Analysis |
| **Logo** | To be supplied (placeholder wordmark used until delivery) |

---

## Table of Contents

1. [Introduction](#1-introduction)
2. [Competitive & Technical Research Findings](#2-competitive--technical-research-findings)
3. [Overall Description](#3-overall-description)
4. [System Architecture](#4-system-architecture)
5. [Technology Stack & Decision Rationale](#5-technology-stack--decision-rationale)
6. [Functional Requirements](#6-functional-requirements)
7. [Data Model](#7-data-model)
8. [API Design](#8-api-design)
9. [Realtime Protocol Specification](#9-realtime-protocol-specification)
10. [Meet — WebRTC Conferencing Architecture](#10-meet--webrtc-conferencing-architecture)
11. [File Server Specification](#11-file-server-specification)
12. [Security Requirements](#12-security-requirements)
13. [Non-Functional Requirements](#13-non-functional-requirements)
14. [Deployment & Infrastructure](#14-deployment--infrastructure)
15. [UX / UI Requirements](#15-ux--ui-requirements)
16. [Testing & Quality Assurance](#16-testing--quality-assurance)
17. [Delivery Roadmap](#17-delivery-roadmap)
18. [Risks & Mitigations](#18-risks--mitigations)
19. [Acceptance Criteria](#19-acceptance-criteria)
20. [Appendices](#20-appendices)

---

## 1. Introduction

### 1.1 Purpose

This document specifies the complete functional, technical, security and operational requirements for **Tupo**, a self-hosted unified communication platform for the NGA institutional ecosystem. It is the contractual baseline for design, implementation, testing and acceptance.

Tupo consolidates into a single product the capabilities currently spread across several third-party tools: instant messaging, group collaboration, video conferencing, institutional mail, file sharing, and a social feed. It is built to run on ordinary AWS EC2 infrastructure alongside the existing NGA Central MIS, and to authenticate its users through the MIS SSO provider so that no new identity silo is created.

### 1.2 Scope

**In scope**

| Module | Summary |
|---|---|
| **Tupo Chat** | 1:1 direct messages, group chats, persistent channels, threads, reactions, mentions, presence, typing indicators, delivery/read receipts, message search |
| **Tupo Meet** | WebRTC audio/video conferencing — scheduled and ad-hoc, screen sharing, recording, chat-in-meeting, raise hand, breakout rooms, live captions |
| **Tupo Files** | Dedicated file service — resumable uploads, previews, thumbnails, versioning, quotas, malware scanning, signed delivery |
| **Tupo Mail** | Internal institutional mailing, distribution lists, announcement broadcasts, templated bulk mail, external SMTP delivery |
| **Tupo Feed** | Facebook-page-style posting: institutional pages, posts, media, comments, reactions, polls, moderation |
| **Tupo Admin** | Workspace administration, role/permission management, retention policies, audit log, moderation queue, analytics |

**Out of scope for v1** (recorded in the roadmap for later phases)

- Native iOS/Android applications (v1 ships an installable PWA; native apps are Phase 6).
- Telephony/PSTN dial-in and SIP gateways.
- Federation with external Matrix/XMPP networks.
- Paid SMS gateway integration (email + web push only in v1).

### 1.3 Definitions, Acronyms and Abbreviations

| Term | Meaning |
|---|---|
| **SFU** | Selective Forwarding Unit — a media server that receives one stream per publisher and forwards it to subscribers without re-encoding |
| **TURN / STUN** | NAT-traversal relay/discovery servers required for WebRTC on restricted networks |
| **E2EE** | End-to-end encryption |
| **MLS** | Messaging Layer Security, RFC 9420 — the IETF standard for scalable group E2EE |
| **DM** | Direct message (1:1 conversation) |
| **Space** | Top-level tenant container (e.g. "NGA Staff", "NGA Students") — equivalent to a Slack workspace |
| **Channel** | Named, persistent, membership-based conversation inside a Space |
| **Thread** | A reply chain anchored to a single parent message |
| **Snowflake ID** | 64-bit, time-sortable, monotonically increasing identifier |
| **CRDT** | Conflict-free replicated data type — used for collaborative text state |
| **PWA** | Progressive Web App — installable, offline-capable web application |
| **MIS** | NGA Central MIS — the system of record for people, roles, programs and academic structure |

### 1.4 References

- NGA Central MIS — `SSO_CLIENT_INTEGRATION.md` (OAuth2 authorization-code flow, `/sso/token`, `/users/me`)
- NGA Central MIS — `API_DOCS.md`, `DEPLOYMENT_GUIDE.md`
- NGA TaskMentor — `PROCTORING_DOCUMENTATION.md` (WebSocket session model, event logging, live monitoring dashboard) — **the reference implementation for Tupo's realtime and streaming layer**
- RFC 9420 — The Messaging Layer Security (MLS) Protocol
- RFC 8825–8835 — WebRTC protocol suite; RFC 5766/8656 — TURN
- OWASP ASVS 4.0 (Level 2) and OWASP Top 10 (2021)
- Rwanda Law N° 058/2021 on the protection of personal data and privacy

### 1.5 Naming

The product is **Tupo**. Service identifiers use the prefix `tupo-`: `tupo-api`, `tupo-realtime`, `tupo-files`, `tupo-sfu`, `tupo-web`, `tupo-worker`. The logo will be delivered separately; until then the UI uses a typographic wordmark and a single accent colour token so the brand can be swapped in one place.

---

## 2. Competitive & Technical Research Findings

Requirements below were derived from a structured review of the four reference products named in the brief, plus current (2026) engineering literature on chat, media and file infrastructure.

### 2.1 Feature benchmark

| Capability | WhatsApp | Slack | Google Meet | Facebook Pages | **Tupo v1** |
|---|---|---|---|---|---|
| 1:1 messaging | ✅ | ✅ | — | ✅ | ✅ |
| Group chat | ✅ (1024) | ✅ | — | — | ✅ (500 members) |
| Persistent named channels | — | ✅ | — | — | ✅ |
| Threaded replies | ⚠️ reply-quote | ✅ | — | ✅ comments | ✅ |
| Reactions | ✅ | ✅ | ✅ | ✅ | ✅ |
| Read receipts | ✅ | ⚠️ per-channel | — | seen state | ✅ (policy-controlled) |
| Typing / presence | ✅ | ✅ | ✅ | — | ✅ |
| Voice notes | ✅ | ✅ (huddles) | — | — | ✅ |
| Message editing / deletion | ✅ | ✅ | — | ✅ | ✅ with tombstones |
| Disappearing messages | ✅ | ⚠️ retention | — | — | ✅ |
| Scheduled send | ⚠️ | ✅ | — | ✅ | ✅ |
| File sharing | ✅ (2 GB) | ✅ (1 GB) | — | ✅ | ✅ (5 GB, resumable) |
| Video meetings | ✅ (32) | ✅ huddles | ✅ (100–1000) | — | ✅ (100 video / 300 audio) |
| Screen share | ✅ | ✅ | ✅ | — | ✅ |
| Recording | — | ✅ | ✅ | — | ✅ |
| Live captions | — | — | ✅ | — | ✅ (Phase 5) |
| Breakout rooms | — | — | ✅ | — | ✅ (Phase 4) |
| Public posting + comments | Channels | Canvas | — | ✅ | ✅ |
| Polls | ✅ | ✅ apps | ✅ | ✅ | ✅ |
| Mail | — | — | — | — | ✅ (differentiator) |
| Bots / webhooks | Business API | ✅ | — | Graph API | ✅ |
| Search | ✅ local | ✅ server | — | ✅ | ✅ typo-tolerant |
| E2EE | ✅ default | ⚠️ enterprise | ✅ optional | — | ⚠️ Phase 6 (MLS) |
| Offline use | ✅ | ✅ | — | ⚠️ | ✅ PWA + IndexedDB |

**Design lessons adopted**

- **From WhatsApp** — device-first delivery semantics (sent → delivered → read as three distinct states, stored per recipient), an outbound queue that survives disconnection, and voice notes as a first-class message type. WhatsApp's simplicity in the compose bar is the model for the mobile layout.
- **From Slack** — the Space → Channel → Thread information hierarchy, `@`-mention and `/`-slash-command grammar, unread badges computed from a per-member `last_read_message_id` watermark, and incoming webhooks as the cheapest possible integration surface.
- **From Google Meet** — join-by-link with a lobby/knock flow, meeting scheduling attached to a calendar entry, a host control panel (mute all, remove, lock), device pre-flight ("check your mic and camera") before joining, and adaptive layouts driven by active-speaker detection.
- **From Facebook Pages** — page-owned posts distinct from personal messages, comment trees with reactions, ranked-vs-chronological feed toggle, and a moderation queue with reporting.

### 2.2 Key technical findings from current literature

1. **Database.** PostgreSQL plus Redis is the proven default for chat at institutional scale; MongoDB adds nothing over it for message data (you lose joins and still need Redis for pub/sub), and ScyllaDB/Cassandra only pays for itself past the ~10⁸-messages-and-growing point that made Discord migrate. For a single-institution deployment on EC2, **PostgreSQL 17 with monthly partitioning on the messages table is the correct choice**, and it leaves a clean migration path if volumes ever justify a wide-column store.
2. **Realtime transport.** Socket.IO with the Redis adapter is the fastest correct path — it gives rooms, namespaces, acknowledgements and automatic reconnection for free. Its known weakness is broadcast amplification: at very large fleets, instances discard most of the pub/sub traffic they receive. Tupo mitigates this from day one by **sharding pub/sub channels per conversation** rather than broadcasting globally, so growth does not require re-architecture.
3. **Media server.** The self-hosted SFUs (LiveKit, mediasoup, Janus) were evaluated first and all carry the same cost: a stateful, UDP-heavy, publicly-addressed server that must be sized, monitored and scaled by hand — for one institution, the single heaviest operational item in the stack. **Cloudflare Realtime is selected instead**: the same SFU semantics reached over an HTTPS API, on Cloudflare's anycast network, with no server to run and the TURN service Tupo already uses sitting alongside it. **Capacity scales with subscribed tracks, not rooms** — which is why the demand-driven subscription in §5.3 is what actually sets the ceiling in §14, not the number of people in the meeting.
4. **Encryption.** For group E2EE, MLS (RFC 9420) has superseded per-pair Double Ratchet fan-out: Signal's group handling is O(N) per membership change, while MLS's ratchet tree is O(log N), and it now has real production deployments. Tupo therefore does **not** build a bespoke group crypto scheme — v1 ships transport + at-rest encryption with server-side keys, and Phase 6 adopts an MLS library.
5. **Files.** The correct pipeline is: client → presigned direct upload to object storage (never through the API process) → completion webhook → async worker for scanning, thumbnails and transcoding → signed short-lived delivery URL. `tus` is the standard for resumable uploads over poor connections, which matters on Rwandan mobile networks.
6. **Search.** PostgreSQL full-text search cannot do typo tolerance well enough for user-facing message search. Meilisearch or Typesense both beat it decisively below ~50M documents at modest RAM cost. **Meilisearch is selected** for its lower operational surface.
7. **Feed fan-out.** Pure fan-out-on-write breaks on high-follower posts; pure fan-out-on-read makes every feed request an N-way fan-in. The hybrid — precomputed timelines for normal authors, read-time merge for institution-wide pages — is the standard answer and is what Tupo implements.
8. **Frontend.** The 2026 consensus stack is React + Vite + TypeScript + Tailwind, with TanStack Query for server state, Zustand for client state, and shadcn/ui components owned in-repo. Long message lists must be virtualized (`react-virtuoso`), and offline behaviour comes from IndexedDB plus a service worker.

---

## 3. Overall Description

### 3.1 Product perspective

Tupo is a **new, independently deployable product** in the NGA ecosystem. It does not own identity: NGA Central MIS remains the system of record for people, roles, programs, classes and academic calendar. Tupo consumes that data through SSO and a scheduled/event-driven sync, and projects it into its own communication-shaped structures (spaces, channels, groups).

```
                 ┌──────────────────────────────┐
                 │      NGA Central MIS         │
                 │  (identity · roles · people) │
                 └───────┬──────────────┬───────┘
                    OAuth2 SSO      Directory sync
                         │          (users, roles, classes)
                         ▼              ▼
   ┌──────────────────────────────────────────────────────┐
   │                        TUPO                          │
   │  Chat · Meet · Files · Mail · Feed · Admin           │
   └──────────────────────────────────────────────────────┘
              ▲                              ▲
      webhooks / events              embedded widgets
              │                              │
   ┌──────────┴─────────┐        ┌───────────┴──────────┐
   │   TaskMentor       │        │ Discipline &         │
   │ (assignments,quiz) │        │ Attendance           │
   └────────────────────┘        └──────────────────────┘
```

**Integration obligations**

- **INT-1** Tupo authenticates users exclusively through the MIS SSO authorization-code flow, then hydrates the profile via `GET /users/me` (profile, roles, permissions, assigned programs/grades, current academic year/terms), with graceful fallback to the minimal token payload if that call fails.
- **INT-2** Tupo mirrors the user's `preferred_theme` from the MIS token so appearance is consistent across all four products.
- **INT-3** Tupo exposes inbound webhooks so TaskMentor can post assignment/quiz notifications and Discipline & Attendance can post alerts into the correct channels.
- **INT-4** Tupo channels can be auto-provisioned from MIS structures (one channel per class, per program, per staff department) and kept in sync as enrolment changes.

### 3.2 User classes

| Class | Description | Primary needs |
|---|---|---|
| **Student** | Enrolled learner | Class channels, DMs with teachers (policy-gated), file submission, joining lessons in Meet, reading the institutional feed |
| **Teacher / Lecturer** | Academic staff | Class channels, announcements, office-hours Meet sessions, file distribution, parent contact |
| **Parent / Guardian** | Linked to one or more students | Receiving announcements, DM with class teacher, joining parent meetings, read-mostly feed access |
| **Administrative staff** | Registry, bursary, HR | Departmental channels, mail broadcasts, document distribution |
| **Space administrator** | Delegated per-space owner | Membership, channel lifecycle, moderation, retention settings |
| **System administrator** | Platform owner | Global configuration, SSO credentials, infrastructure, audit, backups |
| **Integration / bot** | Machine principal | Webhook posting, scoped API access |

### 3.3 Operating environment

| Aspect | Requirement |
|---|---|
| Server OS | Ubuntu 22.04/24.04 LTS on AWS EC2 |
| Runtime | Node.js 22 LTS, TypeScript 5.6+ |
| Browsers | Chrome/Edge 120+, Firefox 120+, Safari 17+ (last two major versions) |
| Mobile | Installable PWA on Android Chrome and iOS Safari |
| Network | Must remain usable on 3G-class links (≤1 Mbps, 300 ms RTT) and behind restrictive NATs |
| Locale | English (default), Kinyarwanda, French |

### 3.4 Constraints

- **C-1** Deployment target is ordinary EC2 instances, not managed AWS services such as Chime, AppSync or Amplify. All infrastructure must be reproducible with Docker Compose + systemd/PM2 and Nginx.
- **C-2** All backend services are Node.js + TypeScript, consistent with the existing NGA codebases (Express, Drizzle ORM). The SFU is the single permitted exception, being an off-the-shelf binary.
- **C-3** Institutional data must remain under NGA control; no message content may be sent to third-party SaaS processors.
- **C-4** The system must degrade gracefully, not fail, when the MIS is unreachable: existing sessions continue to work and only new logins are blocked.
- **C-5** Budget assumption: the platform must serve ~5,000 registered users and ~1,200 daily active users within a single-region, 3–5 instance EC2 footprint.

### 3.5 Assumptions and dependencies

- **A-1** MIS SSO client credentials for Tupo will be issued before development of the auth module begins.
- **A-2** A DNS zone (`tupo.amashuri.com` or equivalent) and wildcard TLS certificate will be available.
- **A-3** UDP ports required by the SFU and TURN can be opened on the security group; if institutional firewalls block UDP, TURN over TCP/TLS on 443 is the fallback and will be enabled by default.
- **A-4** Object storage is S3 or a self-hosted MinIO cluster on EBS; the file service must work identically against either.
- **A-5** An SMTP relay (Amazon SES or institutional relay) is available for outbound mail.

---

## 4. System Architecture

### 4.1 Service decomposition

Tupo is a **modular monorepo of small services**, not a distributed microservice estate. The split is chosen so that each service has a different scaling axis, and so a fault in one (e.g. media) cannot take down the others.

| Service | Language / runtime | Responsibility | Scaling axis |
|---|---|---|---|
| `tupo-web` | React 18/19 + Vite + TS | SPA/PWA client; served as static assets via Nginx/CloudFront | CDN |
| `tupo-api` | Node 22 + Express + TS | REST/HTTP: auth, spaces, channels, messages (write path), feed, mail, admin, search proxy | CPU, stateless — horizontal |
| `tupo-realtime` | Node 22 + Socket.IO + TS | WebSocket gateway: connection registry, presence, live delivery, typing, receipts, signalling relay | Concurrent connections — horizontal |
| `tupo-files` | Node 22 + Express + TS | Upload orchestration, presigned URLs, tus endpoint, metadata, quotas, signed delivery, previews | I/O + storage |
| `tupo-worker` | Node 22 + BullMQ + TS | Async jobs: fan-out, notifications, mail send, virus scan, thumbnails, transcode, search indexing, retention sweeps | Queue depth |
| Cloudflare Realtime SFU | Managed (no deployment) | WebRTC media routing, simulcast | Subscribed tracks — absorbed by Cloudflare |
| Cloudflare Realtime TURN | Managed (no deployment) | STUN/TURN NAT traversal | Relayed bandwidth |

### 4.2 Deployment topology

```
                              Internet
                                 │
                     ┌───────────┴────────────┐
                     │  Nginx / ALB (TLS)     │
                     └───┬─────────┬──────────┘
             /api, /files│         │ /socket.io  (sticky, WS upgrade)
                         ▼         ▼
        ┌────────────────────┐  ┌────────────────────┐
        │  tupo-api  (xN)    │  │ tupo-realtime (xN) │
        └─────┬──────┬───────┘  └────┬───────┬───────┘
              │      │               │       │
              │      └──── Redis ────┘       │  (pub/sub · presence ·
              │             │                │   session registry · rate limit)
              │             ▼                │
              │        ┌─────────┐           │
              │        │ BullMQ  │◀──────────┘
              │        │ queues  │
              │        └────┬────┘
              │             ▼
              │      ┌──────────────┐      ┌──────────────┐
              │      │ tupo-worker  │─────▶│  Meilisearch │
              │      └──────┬───────┘      └──────────────┘
              ▼             ▼
        ┌───────────────────────────┐     ┌─────────────────────┐
        │  PostgreSQL 17 (primary)  │────▶│  Read replica       │
        │  + partitioned messages   │     │  (analytics/search) │
        └───────────────────────────┘     └─────────────────────┘

        ┌──────────────┐   ┌──────────────┐   ┌──────────────┐
        │  tupo-files  │──▶│  S3 / MinIO  │   │  ClamAV svc  │
        └──────────────┘   └──────────────┘   └──────────────┘

        ┌──────────────┐   ┌──────────────┐
        │  tupo-sfu    │◀─▶│   coturn     │   (UDP 50000-60000 / 3478 / 443)
        └──────────────┘   └──────────────┘
```

### 4.3 Message write path (canonical flow)

This is the single most important flow in the system and every implementation decision below follows from it.

1. Client composes a message, generates a **client-side `nonce` (UUIDv7)**, optimistically renders it as `pending`, and persists it to IndexedDB.
2. Client emits `message:send` over the WebSocket with an acknowledgement callback (HTTP `POST /messages` is the fallback path when the socket is down).
3. `tupo-realtime` validates the session, checks channel membership and rate limits, then calls the message service.
4. The service assigns a **Snowflake ID** (time-sortable), assigns a per-conversation monotonic `seq`, and writes the row to PostgreSQL inside a transaction that also bumps `conversations.last_message_id`.
5. The `nonce` is stored with a unique index on `(conversation_id, sender_id, nonce)`, making retries **idempotent** — a duplicate resolves to the original row instead of a second message.
6. The server acknowledges to the sender with `{id, seq, server_ts}`; the client reconciles the optimistic row (status → `sent`).
7. The service publishes to the Redis channel `conv:{conversation_id}`. Only realtime nodes holding a subscriber for that conversation receive it — this is the sharding that avoids Socket.IO broadcast amplification.
8. Each realtime node emits `message:new` to its locally connected members and writes per-recipient delivery rows (`delivered_at`) as clients acknowledge.
9. A fan-out job is enqueued for offline recipients: push notification, unread counter increment, mention email, digest scheduling.
10. The search indexing job upserts the message body into Meilisearch.

**Ordering guarantee.** Messages within a conversation are totally ordered by `(seq)`, which is allocated server-side; clients render strictly by `seq` and never by client timestamp. Across conversations, no ordering is promised. This is the same guarantee Slack and WhatsApp provide, and it is what makes offline reconciliation tractable.

**Gap recovery.** On reconnect the client sends its highest known `seq` per open conversation; the server replies with everything above it, or with a `reset` instruction if the gap exceeds the replay window (default 1,000 messages), in which case the client refetches a page via REST.

---

## 5. Technology Stack & Decision Rationale

Each choice below is recorded as a decision with its alternatives and the reason for rejection, so that the team can revisit it deliberately rather than by accident.

### 5.1 Database — **PostgreSQL 17 + Redis 7**

| Requirement | How it is met |
|---|---|
| High-write append-heavy message table | `messages` **declaratively partitioned by month** on `created_at`; only the hot partition is written to, indexes stay small, and old partitions are detached and archived cheaply |
| Ordered reads within a conversation | `PRIMARY KEY (conversation_id, seq)` with a `BRIN` index on `created_at` per partition |
| Relational integrity for members, roles, permissions | Native foreign keys — the thing MongoDB gives up |
| Flexible per-message payloads (attachments, polls, rich blocks) | `JSONB` columns with GIN indexes where queried |
| Pub/sub, presence, typing, rate limiting, unread counters, session registry | Redis (ephemeral state only — never the source of truth) |
| Job queues | BullMQ on the same Redis, separate logical DB |
| Analytics without hurting the hot path | Streaming read replica |

**Alternatives considered.** *MongoDB* — rejected: no relational integrity, no built-in pub/sub, and no meaningful write advantage at this scale. *ScyllaDB/Cassandra* — rejected for v1: the operational burden (repairs, compaction tuning, hot-partition management) is unjustified below the ~100M-message threshold, and the partitioning scheme above gives a clean migration path if that day comes. *MySQL* (as used by the MIS) — rejected: weaker partitioning ergonomics, weaker `JSONB` equivalent, and no `LISTEN/NOTIFY`. Tupo is a separate service with its own datastore; polyglot persistence across NGA products is intentional and carries no coupling cost since integration is over HTTP.

**Sizing.** At 1,200 DAU × 60 messages/day ≈ 72k messages/day ≈ 26M/year. A single `db.m6i.large`-class instance with 100 GB gp3 handles this with large headroom; the partitioning exists to keep it that way in year five, not to solve a year-one problem.

### 5.2 Realtime — **Socket.IO 4 + `@socket.io/redis-adapter` + Redis Streams**

Chosen for built-in rooms, namespaces, acknowledgements, automatic reconnection with exponential backoff, and long-polling fallback for hostile networks — all of which would otherwise be hand-rolled on top of raw `ws`.

**Mitigation of the known scaling weakness.** Rather than relying on the default global broadcast, Tupo:
- subscribes each realtime node only to `conv:{id}` channels for conversations it actually holds subscribers for;
- uses `@socket.io/redis-streams-adapter` for at-least-once delivery of critical events;
- keeps a **session registry** in Redis (`sess:{user_id}:{device_id} → node_id`) so targeted delivery is a direct route rather than a broadcast;
- partitions namespaces per module (`/chat`, `/meet`, `/feed`, `/presence`).

*Rejected:* raw `uWebSockets.js` (faster, but every feature above becomes bespoke code — revisit only if profiling proves Socket.IO is the bottleneck); managed Ably/Pusher (violates C-3 data-control constraint).

### 5.3 Media — **Cloudflare Realtime (SFU + TURN)**, with WebRTC signalling patterned on the TaskMentor proctoring module

Cloudflare Realtime is selected over the self-hosted SFUs (LiveKit, mediasoup, Janus). All four route media competently; the difference is what has to be operated. A self-hosted SFU is a stateful server on a public IP with a wide UDP range, sized against a CPU curve, scaled by hand and monitored as its own tier — for a single-institution deployment, the heaviest thing in the stack by some margin. Cloudflare Realtime offers the same primitives (sessions, published and pulled tracks, simulcast) behind an HTTPS API on an anycast network, with nothing to deploy, and the TURN service Tupo already borrows from TaskMentor's proctoring module is part of the same product.

Two consequences follow, and both are load-bearing:

- **The app secret never reaches the browser.** Cloudflare authenticates with one long-lived app secret, so every SFU call is proxied through `POST /api/meet/:id/sfu`, which authorises the caller against the meeting first and refuses a track name that does not belong to the calling participant.
- **There is no server-side recording.** Cloudflare Realtime routes tracks; it does not composite them, and there is no Egress equivalent. Recording is therefore made in the host's browser — the stage drawn onto a canvas, all audio mixed through one `AudioContext`, `MediaRecorder` on top, uploaded to the file service under `meetings/<id>/`. Its limits are real and are stated in the UI: it captures what the host could see, and it stops if the host leaves.

Capacity comes from **demand-driven subscription** rather than from the media server: a client pulls audio for everyone publishing but video only for the tiles actually on screen (25 or so), which is what makes a 500-person meeting a bounded amount of traffic per participant instead of a quadratic one.

Where no media server is configured at all, Meet falls back to a peer-to-peer mesh capped at 4 participants, so the module works with no media infrastructure whatsoever.

The **signalling and session-lifecycle patterns are lifted directly from TaskMentor's proctoring module**, which already proved this shape in production: a server-issued opaque session token, a WebSocket channel per session (`/api/proctoring/ws/session/:token`), typed events with severity, and a live monitoring dashboard fed by the same stream. Tupo reuses that model: `meet_sessions` ≙ `proctoring_sessions`, `meet_events` ≙ `proctoring_events`, and the host console is the analogue of the live proctoring dashboard.

### 5.4 File service — **Node + TS, tus + presigned S3/MinIO multipart**

Files never transit `tupo-api`. The client asks `tupo-files` for an upload ticket, uploads directly to object storage (resumable via tus for large or unreliable transfers, presigned multipart for large files on good links), and the completion webhook enqueues post-processing. Delivery is via short-lived signed URLs, never public buckets. This extends the pattern already used by the existing MIS `file-server` service, upgraded with resumability, scanning and quotas.

### 5.5 Frontend — **React + TypeScript + Vite + Tailwind**

| Concern | Choice | Why |
|---|---|---|
| Build | Vite 6 | Matches existing NGA frontends |
| Styling | Tailwind CSS 4 + CSS variables for theming | Token-driven light/dark, brand swap in one file |
| Components | shadcn/ui (Radix primitives), owned in-repo | Accessible by default, no version lock-in |
| Server state | TanStack Query v5 | Caching, background refetch, optimistic mutations, offline persistence |
| Client state | Zustand | Minimal boilerplate for socket/session/UI state |
| Routing | React Router 7 | Consistent with the MIS frontend |
| Long lists | `react-virtuoso` | Correct reverse-scroll and variable-height handling for chat |
| Rich text | TipTap | Already in the NGA stack; mentions, code blocks, math |
| Forms & validation | React Hook Form + Zod (schemas shared with backend) | One source of truth for contracts |
| Offline | Dexie (IndexedDB) + Workbox service worker | Read history offline, queue outbound messages |
| Media | Browser `RTCPeerConnection` directly | Cloudflare Realtime is an HTTPS API, not an SDK; perfect negotiation is ~200 lines and adds no bundle weight |
| Motion | Framer Motion | Already in the NGA stack |
| i18n | `i18next` | English · Kinyarwanda · French |
| Charts | Recharts | Admin analytics, consistent with MIS |

### 5.6 Supporting technology

| Need | Choice | Note |
|---|---|---|
| Search | **Meilisearch** | Typo-tolerant, instant, low ops; per-user filtering by ACL at query time |
| Queues / scheduling | **BullMQ** | Retries, backoff, repeatable jobs, dead-letter |
| Push notifications | **Web Push (VAPID)** + FCM in Phase 6 | No third-party message content exposure |
| Mail transport | **Nodemailer → SES/institutional SMTP** | With DKIM/SPF/DMARC |
| Malware scanning | **ClamAV daemon** as a containerized service | Persistent `clamd` avoids per-scan cold start |
| Media processing | **FFmpeg** + **sharp** | Thumbnails, waveform peaks for voice notes, transcode to H.264/AAC |
| Observability | **Prometheus + Grafana + Loki**, `pino` structured logs, OpenTelemetry traces | |
| Errors | **Sentry** (self-hosted or SaaS with PII scrubbing) | |
| ORM / migrations | **Drizzle ORM** | Same as MIS backend; typed SQL, versioned migrations |
| API contracts | **OpenAPI 3.1** generated from Zod; **AsyncAPI 3** for socket events | |
| Testing | Vitest, Supertest, Playwright, k6 | |
| CI/CD | GitHub Actions → build, test, image push, deploy | |
| Process management | Docker Compose (+ PM2 for parity with existing NGA deployments) | |

---

## 6. Functional Requirements

Requirements are identified as `FR-<MODULE>-<n>` and carry a priority: **M** (must, v1), **S** (should, v1 if time), **C** (could, later phase).

### 6.1 Authentication & Identity — `FR-AUTH`

| ID | Pri | Requirement |
|---|---|---|
| FR-AUTH-1 | M | Users sign in exclusively via NGA MIS SSO using the OAuth2 authorization-code flow. Tupo redirects to the MIS login URL with `client_id` and `redirect_uri`, receives a `code` at `/sso/callback`, and exchanges it **server-side** at `POST /sso/token` using the client secret. |
| FR-AUTH-2 | M | Immediately after exchange, Tupo calls `GET /users/me` to hydrate profile, roles, permissions, assigned programs/grades and current academic year/terms. If that call fails, login still succeeds using the minimal `user`/`permissions` payload, and hydration is retried in the background. |
| FR-AUTH-3 | M | Tupo issues its own session: a short-lived access JWT (15 min) and a rotating refresh token (30 days) bound to a device record, stored in `httpOnly`, `Secure`, `SameSite=Lax` cookies. |
| FR-AUTH-4 | M | Multi-device sessions are supported. Each device has an id, a label (browser/OS), a last-seen timestamp and an IP; a user can list and revoke devices individually or all-but-current. |
| FR-AUTH-5 | M | WebSocket connections authenticate with the same access token during the handshake and are force-disconnected on token revocation. |
| FR-AUTH-6 | M | `preferred_theme` from the MIS token is applied on first load. |
| ~~FR-AUTH-7~~ | — | ~~Break-glass local admin accounts (max 3, TOTP-protected).~~ **STRUCK.** Tupo must have no login of its own, and a break-glass credential is a second login path. Replaced by the sibling-app approach: an `ADMIN_USERNAMES`/`ADMIN_EMAILS` allowlist that elevates a user *who has already authenticated through the MIS*. No credential is ever stored. |
| FR-AUTH-8 | M | Bot/integration principals authenticate with scoped, revocable API keys — never with a user session. |
| FR-AUTH-9 | M | All authentication events (login, refresh, revoke, failure) are written to the audit log with IP and user agent. |

### 6.2 Directory, Presence & Profiles — `FR-USR`

| ID | Pri | Requirement |
|---|---|---|
| FR-USR-1 | M | A nightly (and on-demand) directory sync imports users, roles, programs, grades and class assignments from the MIS; deactivated MIS users are deactivated in Tupo within one sync cycle. |
| FR-USR-2 | M | Profile shows display name, avatar, role, department/class, pronouns (optional), status message and local time. |
| FR-USR-3 | M | Presence states: `online`, `away` (5 min idle), `busy`, `in-a-meeting` (set automatically while in Meet), `do-not-disturb`, `offline`. Presence is Redis-backed with a 45-second heartbeat and a 90-second expiry. |
| FR-USR-4 | M | Custom status with emoji and an optional expiry ("Back at 14:00"). |
| FR-USR-5 | M | Directory search by name, role, class, department, with results filtered by the requester's visibility policy. |
| FR-USR-6 | M | **Contact policy engine.** Administrators define who may initiate a DM with whom (e.g. students may DM teachers assigned to their class but not other students' parents). Violations are blocked at the API, not just hidden in the UI. |
| FR-USR-7 | S | Block and report a user; blocked users cannot DM or mention the blocker. |
| FR-USR-8 | M | Per-user preferences: language, theme, notification rules, read-receipt participation, enter-to-send behaviour. |

### 6.3 Spaces, Channels & Membership — `FR-CHN`

| ID | Pri | Requirement |
|---|---|---|
| FR-CHN-1 | M | A **Space** is the tenant container with its own members, roles, retention policy and branding. At minimum: NGA Staff, NGA Students, NGA Parents. |
| FR-CHN-2 | M | Channel types: `public` (discoverable and joinable within the space), `private` (invite only), `announcement` (only authorised posters write, everyone reads), `dm` (1:1), `group` (ad-hoc multi-party, up to 500). |
| FR-CHN-3 | M | Channels carry: name, topic, description, purpose, avatar/colour, created-by, archived flag. |
| FR-CHN-4 | M | Channel roles: `owner`, `admin`, `moderator`, `member`, `guest` — each with a distinct permission set (post, invite, pin, delete-others, manage-members, manage-settings, start-meeting). |
| FR-CHN-5 | M | **Auto-provisioned channels** from MIS structures: one per class, per program cohort, per staff department; membership follows enrolment automatically and is reconciled on each sync. |
| FR-CHN-6 | M | Join, leave, invite (by user or by link with expiry and use-limit), remove member, transfer ownership. |
| FR-CHN-7 | M | Archive (read-only, searchable) and delete (soft, with a 30-day admin restore window). |
| FR-CHN-8 | S | Guest accounts scoped to specific channels only, with an expiry date — for external examiners, visiting partners, vendors. |
| FR-CHN-9 | M | Per-channel notification setting: all messages · mentions only · muted. |
| FR-CHN-10 | S | Channel sections/folders and starred channels in the sidebar. |

### 6.4 Messaging — `FR-MSG`

| ID | Pri | Requirement |
|---|---|---|
| FR-MSG-1 | M | Send/receive text messages in DMs, groups and channels with sub-500 ms p95 end-to-end delivery on the same region. |
| FR-MSG-2 | M | Message types: `text`, `rich_text`, `file`, `image`, `video`, `audio/voice_note`, `poll`, `system`, `call_event`, `post_share`. |
| FR-MSG-3 | M | Rich text: bold, italic, strikethrough, inline code, code blocks with syntax highlighting, blockquote, ordered/unordered lists, links, and inline math (KaTeX — required for the academic context). |
| FR-MSG-4 | M | `@user`, `@channel`, `@here` mentions with autocomplete; mention notifications bypass "mentions only" muting rules but respect DND. |
| FR-MSG-5 | M | Emoji reactions with per-emoji counts and reactor lists; custom space emoji uploads. |
| FR-MSG-6 | M | **Threaded replies.** Every message can anchor a thread; thread replies do not flood the main channel unless explicitly "also sent to channel". Thread participants are followed automatically. |
| FR-MSG-7 | M | Quote-reply to a specific message with a jump-to-original affordance. |
| FR-MSG-8 | M | Edit own message within an admin-configured window (default 24 h); edits keep a version history and display an "edited" marker. |
| FR-MSG-9 | M | Delete own message (soft delete → tombstone "This message was deleted"); moderators may delete others' messages, which is always audit-logged. |
| FR-MSG-10 | M | Forward a message to one or more conversations, retaining attribution. |
| FR-MSG-11 | M | Pin messages to a channel; pinned list is accessible from the channel header. |
| FR-MSG-12 | M | Bookmark/save messages to a personal "Saved items" list. |
| FR-MSG-13 | M | **Delivery states per recipient**: `sent` → `delivered` → `read`, with the WhatsApp double-check UI. Read receipts are a space-level policy and a per-user opt-out. |
| FR-MSG-14 | M | Typing indicators, throttled to one event per 3 seconds per user per conversation and expiring after 6 seconds of silence. |
| FR-MSG-15 | M | Unread state per member: `last_read_seq` watermark, unread count, unread mention count, and a "new messages" divider on re-entry. |
| FR-MSG-16 | M | Message history pagination: infinite scroll upward, jump-to-date, jump-to-message, and permalinks. |
| FR-MSG-17 | M | Drafts persist per conversation across devices and reloads. |
| FR-MSG-18 | S | Scheduled send ("send Monday 08:00") with a manageable pending queue. |
| FR-MSG-19 | S | Disappearing messages per conversation (24 h / 7 d / 90 d), enforced by a retention worker. |
| FR-MSG-20 | M | Voice notes: record, waveform preview, playback with variable speed, and server-side transcoding to a web-safe codec. |
| FR-MSG-21 | M | Polls: single or multi-choice, optional anonymity, live result bars, closing time. |
| FR-MSG-22 | S | Link unfurling with server-side preview fetch (SSRF-protected allowlist, no private IP ranges). |
| FR-MSG-23 | M | Idempotent send: retrying with the same `nonce` never creates a duplicate. |
| FR-MSG-24 | M | Offline queue: messages composed offline are stored in IndexedDB, shown as `pending`, and flushed in order on reconnect. |
| FR-MSG-25 | C | Inline translation of a message between English, Kinyarwanda and French. |
| FR-MSG-26 | S | Slash commands (`/meet`, `/poll`, `/remind`, `/away`, `/invite`, `/archive`), extensible by integrations. |

### 6.5 Meet — Video Conferencing — `FR-MEET`

| ID | Pri | Requirement |
|---|---|---|
| FR-MEET-1 | M | Instant meeting from any conversation ("Start a call"), and standalone meetings created from a link. |
| FR-MEET-2 | M | Scheduled meetings with title, description, start/end, recurrence, and an invitee list; ICS invitations sent by mail. |
| FR-MEET-3 | M | Join by link, by conversation, or from the meetings list. Anonymous/guest join is allowed only when the host enables it, and always lands in the lobby. |
| FR-MEET-4 | M | **Pre-join device check**: camera preview, microphone level meter, speaker test, device selection, background blur toggle, and a "join muted" default. |
| FR-MEET-5 | M | **Lobby / knock-to-enter** with host admit/deny, and a "lock meeting" control. |
| FR-MEET-6 | M | Audio and video for up to **100 video participants** or **300 audio-only participants** per room. |
| FR-MEET-7 | M | Screen sharing (full screen, window or browser tab) with optional system audio; at most 2 concurrent shares. |
| FR-MEET-8 | M | Layouts: grid, speaker-focus (driven by active-speaker detection), sidebar, and pin/spotlight a participant. |
| FR-MEET-9 | M | Host controls: mute participant, mute all, disable participant camera, remove participant, promote co-host, end meeting for all, disable chat, disable screen share. |
| FR-MEET-10 | M | In-meeting chat, persisted back into the originating conversation when there is one. |
| FR-MEET-11 | M | Raise hand, emoji reactions, and a participant list with mute/connection indicators. |
| FR-MEET-12 | M | **Recording** (composite audio+video+screen) started by the host, with a visible recording indicator and consent notice; recordings land in `tupo-files` with channel-scoped access. |
| FR-MEET-13 | M | Adaptive quality: simulcast layers, automatic downgrade on packet loss, audio-only fallback, and a visible connection-quality indicator. |
| FR-MEET-14 | M | Meeting session events (join, leave, mute, share start/stop, network drop, recording start/stop) logged with severity — mirroring the TaskMentor proctoring event model. |
| FR-MEET-15 | M | Post-meeting summary: duration, attendee list with join/leave times, chat transcript, recording link. **Attendance export is required for lesson delivery evidence.** |
| FR-MEET-16 | S | Breakout rooms: automatic or manual assignment, timer, broadcast-to-all, return-to-main. |
| FR-MEET-17 | C | Live captions and post-meeting transcript (self-hosted Whisper on the worker tier). |
| FR-MEET-18 | S | Virtual backgrounds and noise suppression (client-side, WASM). |
| FR-MEET-19 | S | Waiting-room "meeting has not started" state until the host joins, when configured. |
| FR-MEET-20 | M | TURN relay over TCP/TLS 443 as automatic fallback when UDP is blocked. |

### 6.6 Files — `FR-FILE`

| ID | Pri | Requirement |
|---|---|---|
| FR-FILE-1 | M | Upload from any composer, drag-and-drop, paste-from-clipboard, or the Files section. Max 5 GB per file (admin-configurable), 10 files per message. |
| FR-FILE-2 | M | **Resumable uploads** via tus with automatic retry; progress, pause and cancel in the UI; an interrupted upload resumes from its last byte after a network change. |
| FR-FILE-3 | M | Files are uploaded **directly to object storage** using signed tickets; file bytes never pass through `tupo-api`. |
| FR-FILE-4 | M | Every upload is scanned by ClamAV before becoming downloadable; infected files are quarantined and the uploader is notified. Status: `uploading` → `scanning` → `ready` / `quarantined` / `failed`. |
| FR-FILE-5 | M | Thumbnails for images and video, page-1 previews for PDF/Office documents, waveform peaks for audio. |
| FR-FILE-6 | M | In-app preview for images, video, audio, PDF, and text/code without download. |
| FR-FILE-7 | M | Access control is derived from the containing conversation or post: a file is visible exactly to those who can see the message that carries it. Delivery uses signed URLs expiring in 15 minutes. |
| FR-FILE-8 | M | Metadata: original name, MIME type (sniffed server-side, not trusted from the client), size, checksum (SHA-256), uploader, created-at, dimensions/duration. |
| FR-FILE-9 | S | Versioning: re-uploading over an existing file creates a new version with a restorable history. |
| FR-FILE-10 | M | Per-user and per-space storage quotas with warning thresholds at 80% and 95%. |
| FR-FILE-11 | M | Deduplication by checksum so a widely forwarded file is stored once. |
| FR-FILE-12 | M | A Files browser per channel and per user: filter by type, uploader, date; sort; search by name. |
| FR-FILE-13 | S | Share link with expiry, optional password and download counter. |
| FR-FILE-14 | M | Retention: files inherit their conversation's retention policy; orphaned files are garbage-collected after 30 days. |
| FR-FILE-15 | M | Video/audio transcoding to a web-safe profile (H.264/AAC, MP4) for cross-browser playback. |

### 6.7 Feed — Posts & Comments — `FR-FEED`

| ID | Pri | Requirement |
|---|---|---|
| FR-FEED-1 | M | **Pages** are posting identities (e.g. "NGA Official", "Sports & Clubs", "Alumni") with owners and editors. Users follow pages; some pages are mandatory-follow for their audience. |
| FR-FEED-2 | M | Create posts with rich text, images (multi-image gallery), video, documents, links and polls. |
| FR-FEED-3 | M | Post audience: public-to-space, role-restricted (e.g. staff only), or class-restricted. |
| FR-FEED-4 | M | Draft, schedule, publish, edit (with edit history), unpublish and delete posts. |
| FR-FEED-5 | M | Comments with one level of nesting (replies to comments), reactions on both posts and comments. |
| FR-FEED-6 | M | Feed ranking: chronological by default with a "Top" toggle; pinned/announcement posts always surface first. |
| FR-FEED-7 | M | **Hybrid fan-out**: posts from ordinary pages are pushed into follower timelines at write time; institution-wide pages above a follower threshold are merged in at read time. |
| FR-FEED-8 | M | Report a post or comment; reports enter a moderation queue with approve/remove/warn actions and an audit trail. |
| FR-FEED-9 | S | Comment controls per post: open, followers-only, or closed. |
| FR-FEED-10 | M | Post analytics for page owners: impressions, unique reach, reactions, comments, click-throughs. |
| FR-FEED-11 | S | Share a post into a chat conversation as a rich card. |
| FR-FEED-12 | M | Live updates: new comments and reaction counts stream to open viewers over the socket without a refresh. |

### 6.8 Mail — `FR-MAIL`

| ID | Pri | Requirement |
|---|---|---|
| FR-MAIL-1 | M | Internal mailbox: compose, send, reply, reply-all, forward, drafts, sent, archive, trash, labels/folders, star. |
| FR-MAIL-2 | M | Threaded conversation view grouped by subject and references. |
| FR-MAIL-3 | M | Attachments handled by `tupo-files` with the same scanning and quota rules. |
| FR-MAIL-4 | M | **Distribution lists** derived from MIS structures (all-staff, all-parents-of-class-4B, all-students-in-program-X) that stay in sync automatically. |
| FR-MAIL-5 | M | Bulk announcements with per-recipient merge fields (name, class, parent-of) and a preview-before-send step. |
| FR-MAIL-6 | M | Reusable templates with a rich-text editor for recurring communications (fee notices, term letters, event invitations). |
| FR-MAIL-7 | M | Outbound delivery via SMTP relay with DKIM/SPF/DMARC alignment, per-minute rate limiting, and bounce/complaint handling that suppresses bad addresses. |
| FR-MAIL-8 | M | Delivery tracking: queued, sent, delivered, bounced, failed — visible per recipient for bulk sends. |
| FR-MAIL-9 | S | Mail can be delivered as an in-app notification when the recipient is an internal user, avoiding external SMTP entirely. |
| FR-MAIL-10 | S | Scheduled sending and per-campaign approval workflow for mail reaching more than 200 recipients. |
| FR-MAIL-11 | C | External IMAP/SMTP account connection so staff can read institutional mail inside Tupo. |

### 6.9 Notifications — `FR-NOTIF`

| ID | Pri | Requirement |
|---|---|---|
| FR-NOTIF-1 | M | In-app notification centre with unread state, grouping and mark-all-read. |
| FR-NOTIF-2 | M | Web Push (VAPID) to the PWA for DMs, mentions, calls and announcements, with the notification body suppressed when the user has enabled privacy mode. |
| FR-NOTIF-3 | M | Email fallback when a user has been offline for longer than a configurable threshold (default 10 minutes) and has unread mentions. |
| FR-NOTIF-4 | M | Daily/weekly digest email of missed activity, per-user configurable. |
| FR-NOTIF-5 | M | Per-user rules: DND schedule (quiet hours), per-channel overrides, mention-only mode, mute-until. |
| FR-NOTIF-6 | M | Incoming call notifications ring across all of a user's active devices and cancel on answer elsewhere. |
| FR-NOTIF-7 | M | Notifications are deduplicated across devices: reading on one device clears the badge on all. |
| FR-NOTIF-8 | S | Keyword alerts ("notify me when someone says 'exam timetable'"). |

### 6.10 Search — `FR-SRCH`

| ID | Pri | Requirement |
|---|---|---|
| FR-SRCH-1 | M | Global search across messages, files, people, channels and posts from a single command palette (`Ctrl/Cmd-K`). |
| FR-SRCH-2 | M | Typo-tolerant, prefix-matching, sub-200 ms p95 results. |
| FR-SRCH-3 | M | **ACL-correct results**: a user can never see a hit from a conversation they are not a member of. Filtering is applied at query time from the requester's channel membership set, not post-filtered in the UI. |
| FR-SRCH-4 | M | Filters: `from:`, `in:`, `before:`, `after:`, `has:file`, `has:link`, `is:pinned`. |
| FR-SRCH-5 | M | Deleted messages are removed from the index within 60 seconds; edited messages are re-indexed. |
| FR-SRCH-6 | S | Search inside file contents (extracted text from PDF/DOCX). |
| FR-SRCH-7 | M | Recent searches and in-conversation search with match highlighting and jump-to-result. |

### 6.11 Administration — `FR-ADM`

| ID | Pri | Requirement |
|---|---|---|
| FR-ADM-1 | M | Admin console: spaces, channels, members, roles, integrations, retention, branding, feature flags. |
| FR-ADM-2 | M | Role and permission management with a matrix editor; custom roles composed from atomic permissions. |
| FR-ADM-3 | M | Retention policies per space and per channel type (e.g. student DMs 1 year, staff channels 5 years, announcements indefinite), executed by a scheduled worker. |
| FR-ADM-4 | M | **Immutable audit log** of privileged actions: role changes, message deletions by moderators, exports, retention edits, integration key issuance, login anomalies. Retained 3 years minimum. |
| FR-ADM-5 | M | Moderation queue for reported messages, posts and users, with actions: dismiss, remove content, warn, mute (timed), suspend. |
| FR-ADM-6 | M | Legal/compliance export: all content for a given user or channel over a date range, as JSON + attachments, requiring two-person authorisation and always audit-logged. |
| FR-ADM-7 | M | Analytics dashboard: DAU/MAU, messages per day, meeting minutes, storage used, top channels, adoption by role. |
| FR-ADM-8 | M | System health page: service status, queue depth, socket connections, DB replication lag, storage headroom. |
| FR-ADM-9 | M | Announcement broadcast to every user in a space, with mandatory-acknowledgement mode for critical notices. |
| FR-ADM-10 | S | Feature flags to enable modules per space (e.g. Feed disabled for the Parents space initially). |
| FR-ADM-11 | M | User lifecycle: suspend, reactivate, and offboard (revoke sessions, transfer channel ownership, retain content per policy). |

### 6.12 Integrations & Extensibility — `FR-INT`

| ID | Pri | Requirement |
|---|---|---|
| FR-INT-1 | M | **Incoming webhooks**: a per-channel signed URL that accepts a JSON payload and posts a formatted message. Used by TaskMentor for assignment/deadline notices and by Discipline & Attendance for alerts. |
| FR-INT-2 | M | **Outgoing webhooks / event subscriptions**: other NGA systems subscribe to `message.created`, `meeting.ended`, `file.uploaded`, `post.published`, delivered with HMAC-SHA256 signatures and exponential-backoff retry. |
| FR-INT-3 | M | Public REST API v1 with API-key or OAuth2 client-credential auth, documented in OpenAPI, rate-limited per key. |
| FR-INT-4 | S | Bot framework: bot identities that can post, read subscribed channels, respond to slash commands and render interactive buttons. |
| FR-INT-5 | S | Embeddable widgets so the MIS and TaskMentor can render a Tupo channel or a "start meeting" button inside their own pages, authenticated by short-lived embed tokens. |
| FR-INT-6 | M | Deep links (`tupo://` / `https://tupo.amashuri.com/c/{id}/{seq}`) so notifications from other systems land on the exact message. |

---

## 7. Data Model

### 7.1 Entity overview

```
users ──< user_devices
  │  └──< user_preferences
  │
spaces ──< space_members >── users
  │
  └──< conversations ──< conversation_members >── users
            │                    └── last_read_seq, notification_pref
            ├──< messages ──< message_attachments >── files
            │       ├──< message_reactions
            │       ├──< message_receipts   (per recipient: delivered_at, read_at)
            │       ├──< message_edits
            │       └──< threads (parent_message_id)
            └──< meetings ──< meeting_participants
                                └──< meeting_events

pages ──< posts ──< comments ──< comment_reactions
   │        └──< post_reactions
   └──< page_followers >── users

files ──< file_versions
mail_messages ──< mail_recipients ──< mail_delivery_events
notifications, audit_log, webhooks, api_keys, retention_policies
```

### 7.2 Core tables (abridged DDL)

```sql
-- Conversations unify DMs, groups and channels behind one abstraction.
CREATE TABLE conversations (
  id              BIGINT PRIMARY KEY,              -- snowflake
  space_id        BIGINT NOT NULL REFERENCES spaces(id),
  type            conversation_type NOT NULL,      -- dm|group|channel|announcement
  slug            CITEXT,                          -- unique per space for channels
  name            TEXT,
  topic           TEXT,
  description     TEXT,
  avatar_file_id  BIGINT,
  is_private      BOOLEAN NOT NULL DEFAULT false,
  is_archived     BOOLEAN NOT NULL DEFAULT false,
  origin          TEXT,                            -- 'manual' | 'mis:class:{id}' | ...
  retention_days  INTEGER,                         -- NULL = inherit space policy
  last_message_id BIGINT,
  last_seq        BIGINT NOT NULL DEFAULT 0,       -- monotonic allocator
  member_count    INTEGER NOT NULL DEFAULT 0,
  created_by      BIGINT REFERENCES users(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at      TIMESTAMPTZ
);
CREATE UNIQUE INDEX ON conversations (space_id, lower(slug)) WHERE slug IS NOT NULL;

CREATE TABLE conversation_members (
  conversation_id BIGINT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id         BIGINT NOT NULL REFERENCES users(id),
  role            member_role NOT NULL DEFAULT 'member',
  last_read_seq   BIGINT NOT NULL DEFAULT 0,
  unread_count    INTEGER NOT NULL DEFAULT 0,
  unread_mentions INTEGER NOT NULL DEFAULT 0,
  notification    notif_pref NOT NULL DEFAULT 'all',   -- all|mentions|none
  muted_until     TIMESTAMPTZ,
  is_starred      BOOLEAN NOT NULL DEFAULT false,
  joined_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  left_at         TIMESTAMPTZ,
  PRIMARY KEY (conversation_id, user_id)
);
CREATE INDEX ON conversation_members (user_id) WHERE left_at IS NULL;

-- Partitioned monthly. Only the current partition is hot.
CREATE TABLE messages (
  id              BIGINT NOT NULL,                 -- snowflake, globally unique
  conversation_id BIGINT NOT NULL,
  seq             BIGINT NOT NULL,                 -- monotonic per conversation
  sender_id       BIGINT NOT NULL,
  type            message_type NOT NULL DEFAULT 'text',
  body            TEXT,                            -- plain-text projection for search
  content         JSONB,                           -- rich blocks / poll / call payload
  parent_id       BIGINT,                          -- thread anchor
  reply_to_id     BIGINT,                          -- quote-reply
  nonce           UUID NOT NULL,                   -- client idempotency key
  mentions        BIGINT[] NOT NULL DEFAULT '{}',
  has_attachments BOOLEAN NOT NULL DEFAULT false,
  is_pinned       BOOLEAN NOT NULL DEFAULT false,
  edited_at       TIMESTAMPTZ,
  deleted_at      TIMESTAMPTZ,
  expires_at      TIMESTAMPTZ,                     -- disappearing messages
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (conversation_id, seq, created_at)
) PARTITION BY RANGE (created_at);

CREATE UNIQUE INDEX ON messages (conversation_id, sender_id, nonce);
CREATE INDEX ON messages USING GIN (mentions);
CREATE INDEX ON messages (parent_id) WHERE parent_id IS NOT NULL;

-- Receipts are separate rows so the message row is never rewritten on read.
CREATE TABLE message_receipts (
  conversation_id BIGINT NOT NULL,
  message_id      BIGINT NOT NULL,
  user_id         BIGINT NOT NULL,
  delivered_at    TIMESTAMPTZ,
  read_at         TIMESTAMPTZ,
  PRIMARY KEY (message_id, user_id)
);

CREATE TABLE files (
  id            BIGINT PRIMARY KEY,
  owner_id      BIGINT NOT NULL REFERENCES users(id),
  space_id      BIGINT NOT NULL,
  storage_key   TEXT NOT NULL,                     -- object-storage path
  bucket        TEXT NOT NULL,
  original_name TEXT NOT NULL,
  mime_type     TEXT NOT NULL,                     -- server-sniffed
  size_bytes    BIGINT NOT NULL,
  checksum      TEXT NOT NULL,                     -- sha256, used for dedup
  status        file_status NOT NULL,              -- uploading|scanning|ready|quarantined|failed
  scan_result   JSONB,
  metadata      JSONB,                             -- width/height/duration/pages
  thumbnail_key TEXT,
  version       INTEGER NOT NULL DEFAULT 1,
  parent_file_id BIGINT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at    TIMESTAMPTZ
);
CREATE INDEX ON files (checksum, space_id);

CREATE TABLE meetings (
  id               BIGINT PRIMARY KEY,
  conversation_id  BIGINT,                         -- NULL for standalone meetings
  room_name        TEXT NOT NULL UNIQUE,           -- media room identity
  join_code        TEXT NOT NULL UNIQUE,
  title            TEXT,
  host_id          BIGINT NOT NULL,
  scheduled_start  TIMESTAMPTZ,
  scheduled_end    TIMESTAMPTZ,
  started_at       TIMESTAMPTZ,
  ended_at         TIMESTAMPTZ,
  status           meeting_status NOT NULL,        -- scheduled|live|ended|cancelled
  settings         JSONB NOT NULL,                 -- lobby, recording, guest join, lock
  recording_file_id BIGINT,
  peak_participants INTEGER,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE meeting_events (        -- mirrors TaskMentor proctoring_events
  id           BIGINT PRIMARY KEY,
  meeting_id   BIGINT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  user_id      BIGINT,
  event_type   TEXT NOT NULL,        -- join|leave|mute|unmute|share_start|reconnect|...
  severity     TEXT NOT NULL DEFAULT 'info',
  payload      JSONB,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

### 7.3 Partitioning and lifecycle

- `messages`, `message_receipts`, `notifications`, `audit_log` and `meeting_events` are **range-partitioned by month**. A scheduled job pre-creates the next two partitions and detaches partitions past the retention horizon.
- Detached partitions are exported to compressed Parquet/S3 before being dropped, so legal export remains possible after online deletion.
- `unread_count` is maintained in Redis for speed and reconciled to PostgreSQL asynchronously; PostgreSQL is authoritative on conflict.

### 7.4 Redis key map

| Key | Type | TTL | Purpose |
|---|---|---|---|
| `presence:{user_id}` | hash | 90 s | status, last heartbeat, device count |
| `sess:{user_id}:{device_id}` | string | session | realtime node holding the socket |
| `conv:{conversation_id}` | pub/sub | — | sharded fan-out channel |
| `typing:{conversation_id}` | set | 6 s | currently typing users |
| `unread:{user_id}:{conversation_id}` | string | — | fast unread counter |
| `rl:{scope}:{principal}` | string | window | sliding-window rate limiter |
| `bull:*` | streams | — | job queues |

---

## 8. API Design

### 8.1 Conventions

- Base path `**/api/v1**`; JSON only; UTF-8; `application/json` unless uploading.
- IDs are strings in JSON (64-bit snowflakes exceed JS `Number.MAX_SAFE_INTEGER`).
- Timestamps are ISO-8601 UTC.
- Cursor pagination: `?limit=50&before=<seq>` / `?after=<seq>`, returning `{data, page:{has_more, next_cursor}}`.
- Errors are RFC 9457 problem documents: `{type, title, status, detail, instance, errors[]}`.
- Every mutating request carries `Idempotency-Key`; replays return the original result.
- Rate limits are advertised in `RateLimit-Limit` / `RateLimit-Remaining` / `RateLimit-Reset`.
- All request/response schemas are Zod-defined and shared with the frontend; OpenAPI 3.1 is generated from them.

### 8.2 Representative endpoints

```
Auth
  GET    /auth/sso/start                     → redirect to MIS login
  POST   /auth/sso/callback                  { code } → session cookies + user
  POST   /auth/refresh
  POST   /auth/logout
  GET    /auth/devices        DELETE /auth/devices/:id

Spaces & channels
  GET    /spaces                             GET /spaces/:id/members
  GET    /conversations?type=&archived=      POST /conversations
  GET    /conversations/:id                  PATCH /conversations/:id
  POST   /conversations/:id/members          DELETE /conversations/:id/members/:userId
  POST   /conversations/:id/read             { seq }
  POST   /conversations/:id/archive
  POST   /conversations/:id/invite-link      { expires_in, max_uses }

Messages
  GET    /conversations/:id/messages?before=&limit=
  POST   /conversations/:id/messages         { nonce, type, body, content, attachments[] }
  GET    /messages/:id                       PATCH /messages/:id       DELETE /messages/:id
  GET    /messages/:id/thread
  POST   /messages/:id/reactions             { emoji }   DELETE /messages/:id/reactions/:emoji
  POST   /messages/:id/pin                   POST /messages/:id/forward   { conversation_ids[] }

Files
  POST   /files/tickets                      { name, size, mime, conversation_id } → upload URL
  POST   /files/:id/complete
  GET    /files/:id                          GET /files/:id/download   (302 → signed URL)
  GET    /files/:id/thumbnail?w=
  GET    /conversations/:id/files

Meet
  POST   /meetings                           { conversation_id?, title, scheduled_start? }
  GET    /meetings/:id                       POST /meetings/:id/token   → transport + SFU endpoint
  POST   /meetings/:id/admit                 { user_id }
  POST   /meetings/:id/recording/start|stop
  POST   /meetings/:id/end
  GET    /meetings/:id/attendance            (CSV/JSON export)

Feed
  GET    /feed?cursor=&sort=recent|top
  GET    /pages/:id/posts                    POST /pages/:id/posts
  PATCH  /posts/:id                          DELETE /posts/:id
  GET    /posts/:id/comments                 POST /posts/:id/comments
  POST   /posts/:id/reactions                POST /posts/:id/report

Mail
  GET    /mail?folder=inbox                  POST /mail        { to[], subject, body, attachments[] }
  POST   /mail/bulk                          { list_id, template_id, variables }
  GET    /mail/:id/delivery

Search / notifications / admin
  GET    /search?q=&type=&in=&from=&before=
  GET    /notifications        POST /notifications/read-all
  GET    /admin/audit-log      GET /admin/analytics      POST /admin/export
  POST   /webhooks/incoming/:token           (signed, from other NGA systems)
```

---

## 9. Realtime Protocol Specification

### 9.1 Connection lifecycle

1. Client connects to `wss://tupo.amashuri.com/socket.io` with the access token in the handshake auth payload.
2. Server validates the token, registers `sess:{user_id}:{device_id} → node_id` in Redis, joins the socket to `user:{user_id}` and to a room per open conversation.
3. Client sends `sync:request` with `{conversations: [{id, last_seq}], last_notification_id}`.
4. Server replies `sync:response` with missed messages, receipt updates, membership changes and presence — or `sync:reset` when the gap is too large.
5. Heartbeat every 25 s; presence refreshed every 45 s.
6. On disconnect, the socket's presence key expires after 90 s; the user goes `offline` only if no other device remains.

### 9.2 Event catalogue

**Client → server**

| Event | Payload | Ack |
|---|---|---|
| `message:send` | `{conversation_id, nonce, type, body, content, attachments[]}` | `{id, seq, created_at}` |
| `message:edit` | `{id, body, content}` | `{edited_at}` |
| `message:delete` | `{id}` | `{ok}` |
| `message:react` | `{id, emoji, action}` | `{counts}` |
| `typing:start` / `typing:stop` | `{conversation_id}` | — |
| `read:mark` | `{conversation_id, seq}` | `{unread_count}` |
| `presence:set` | `{status, custom, expires_at}` | `{ok}` |
| `conversation:subscribe` / `unsubscribe` | `{conversation_id}` | `{ok}` |
| `sync:request` | `{conversations[], last_notification_id}` | `sync:response` |
| `meet:signal` | `{meeting_id, ...}` | relayed |

**Server → client**

| Event | Meaning |
|---|---|
| `message:new` | New message in a subscribed conversation |
| `message:updated` / `message:deleted` | Edit or tombstone |
| `message:receipt` | Delivery/read state changed for a message you sent |
| `reaction:updated` | Reaction counts changed |
| `typing:update` | Current typing set for a conversation |
| `presence:update` | A visible user's presence changed |
| `conversation:updated` | Metadata, membership or archive state changed |
| `unread:update` | Authoritative unread counters (for cross-device badge sync) |
| `notification:new` | New notification-centre item |
| `meet:invite` / `meet:state` / `meet:ended` | Call ringing, participant/host state, teardown |
| `feed:comment` / `feed:reaction` | Live post activity |
| `system:reconnect_required` | Token revoked or server draining |

### 9.3 Delivery guarantees

- **Acknowledged, at-least-once** delivery for `message:*` and `notification:new`, deduplicated client-side by message id.
- **Best-effort, fire-and-forget** for `typing:*` and `presence:*` — these are never persisted and are safe to drop.
- Any event not acknowledged within 10 seconds is retried by the client, relying on `nonce` idempotency.
- Realtime is an **optimization, not a requirement**: every realtime action has an equivalent REST endpoint, and the client automatically falls back to polling every 15 seconds when the socket cannot be established.

---

## 10. Meet — WebRTC Conferencing Architecture

### 10.1 Topology

```
   Participant A                Participant B                 Participant C
        │  (1) POST /meetings/:id/token                             │
        └──────────────► tupo-api ── authorises, proxies to the SFU ──┘
                             │  (room, identity, canPublish, canSubscribe, TTL 4h)
                             ▼
   ┌───────────────────────────────────────────────────────────────┐
   │              Cloudflare Realtime SFU (managed)                │
   │  publish 1 stream ▲   forward N streams ▼  simulcast layers   │
   └───────────────────────────────────────────────────────────────┘
                 ▲                                  │
        ICE/DTLS/SRTP via coturn            Egress → composite
        (UDP 50000-60000, TCP/TLS 443)      recording → tupo-files

   tupo-realtime carries application signalling in parallel:
   lobby knocks, host commands, raise-hand, in-meeting chat, reactions.
```

**Division of responsibility.** Cloudflare Realtime owns *media* (ICE, DTLS-SRTP, simulcast, bandwidth estimation). `tupo-realtime` owns *application state* (who is in the lobby, who is co-host, hand-raise order, chat). Keeping these apart means a media-server restart does not lose meeting state, and application features do not require touching WebRTC internals.

### 10.2 Reuse of the TaskMentor proctoring model

The proctoring module already established, in production, the exact session pattern Tupo needs. It is reused rather than reinvented:

| TaskMentor proctoring | Tupo Meet |
|---|---|
| `proctoring_sessions` keyed by opaque `session_token` | `meetings` keyed by `room_name` + `join_code` |
| `ws://…/ws/session/:token` per-session channel | `/meet` namespace room per `meeting_id` |
| `proctoring_events` with `severity` and payload | `meeting_events` with the same shape |
| `LiveProctoringDashboard` (live tiles, per-session drill-down) | Host console (participant tiles, per-participant controls) |
| Session state machine with connection tracking | Participant state machine (`lobby → connecting → active → reconnecting → left`) |
| `ProctoringSettings` per quiz | `meetings.settings` JSONB per meeting |
| Analytics + export endpoints | Attendance export endpoints |

Where proctoring is required *during* a Tupo-hosted assessment, the two systems compose: TaskMentor remains the proctor of record, and Tupo supplies the meeting.

### 10.3 Media requirements

| Requirement | Specification |
|---|---|
| Codecs | VP8/VP9 and H.264 for video, Opus for audio; AV1 opportunistically where supported |
| Simulcast | Three spatial layers (180p/360p/720p); the SFU selects per subscriber based on available bandwidth and layout size |
| Dynacast | Layers not being consumed are paused at the publisher to save uplink |
| Bandwidth budget | ~1 Mbps per 720p stream, ~150 kbps per 180p stream, ~40 kbps per audio stream |
| Degradation ladder | 720p → 360p → 180p → audio-only, automatic and reversible |
| Reconnection | ICE restart with session resume; the participant list must not flicker on a sub-10 s reconnect |
| Recording | Server-side composite (Egress) — never client-side — written directly to object storage |
| Echo/noise | Browser AEC/AGC/NS enabled; optional WASM noise suppression |
| Security | Media is DTLS-SRTP encrypted in transit; room JWTs are per-user, per-meeting, short-lived and non-transferable |

### 10.4 Capacity model

Load is a function of **subscribed tracks**, not participants. In a meeting of N participants all publishing camera and microphone, a naive client pulls `N − 1` video streams and the SFU forwards `N × (N−1)` of them — quadratic, and the reason large meetings collapse. Tupo does not do that: a client subscribes to audio for everyone publishing but video only for the tiles on screen, so per-participant traffic is bounded by the grid size (~25) rather than by attendance. Cloudflare absorbs the forwarding side, so there is no node CPU curve to size against.

Tupo therefore enforces, and the UI communicates, the following limits:

| Scenario | Limit | Rationale |
|---|---|---|
| Standard class/staff meeting | 100 video participants | Grid renders only the top 25 by active-speaker; the rest are audio + avatar, so subscription count stays bounded |
| Large assembly | 300 audio-only + up to 5 video publishers | "Webinar mode" — presenters publish, audience subscribes |
| Concurrent meetings | Bounded by Cloudflare's per-app limits, not by Tupo hardware | No action — the SFU tier scales on Cloudflare's side |

---

## 11. File Server Specification

`tupo-files` is a standalone Node + TypeScript service, evolving the existing MIS `file-server` with resumability, scanning, quotas and signed delivery.

### 11.1 Upload pipeline

```
 1. Client → POST /files/tickets  {name, size, mime, conversation_id}
        ├─ authorise (membership + quota + type allowlist + size limit)
        └─ returns { file_id, strategy, upload_url | tus_endpoint, expires_at }

 2. Client → uploads DIRECTLY to object storage
        ├─ ≤ 5 MB  : single presigned PUT
        ├─ > 5 MB  : presigned multipart (8 MB parts, parallel, retryable)
        └─ unstable network : tus resumable (chunked, offset-resume)

 3. Client → POST /files/:id/complete
        └─ verifies size + SHA-256 checksum, marks `scanning`, enqueues jobs

 4. tupo-worker
        ├─ ClamAV scan (clamd service)  → quarantine on hit, notify uploader
        ├─ MIME sniff (magic bytes) — the client-declared type is never trusted
        ├─ dedup by checksum within the space
        ├─ thumbnails (sharp) / video poster + transcode (FFmpeg) / PDF page-1
        ├─ text extraction for search indexing
        └─ status → `ready`, emits `file:ready` over the socket

 5. Delivery → GET /files/:id/download
        └─ authorise → 302 to a 15-minute signed URL (or CloudFront signed URL)
```

### 11.2 Requirements

| ID | Requirement |
|---|---|
| FS-1 | Buckets are private. No object is ever publicly readable. |
| FS-2 | Storage keys are `spaces/{space_id}/{yyyy}/{mm}/{file_id}/{sanitised_name}` — never client-controlled paths. |
| FS-3 | Extension/MIME allowlist per space; executables and scripts are rejected by default. |
| FS-4 | Server-side encryption at rest (SSE-S3/SSE-KMS, or MinIO SSE). |
| FS-5 | Quota enforcement before ticket issuance, not after upload. |
| FS-6 | Range requests supported for audio/video seeking. |
| FS-7 | Thumbnails cached at 3 widths (64/256/1024 px) and served with long-lived immutable cache headers. |
| FS-8 | An orphan sweep reclaims tickets never completed within 24 h and files unreferenced for 30 days. |
| FS-9 | Structured access logging of every download with actor, file and IP, for audit. |
| FS-10 | Health endpoint reporting storage reachability, queue depth and scanner liveness. |

---

## 12. Security Requirements

### 12.1 Authentication & session security

| ID | Requirement |
|---|---|
| SEC-A1 | OAuth2 authorization-code flow with PKCE; `state` parameter validated to prevent CSRF on the callback; `redirect_uri` matched against an exact allowlist. |
| SEC-A2 | Client secret exists only in `tupo-api` environment configuration; it is never present in any client bundle. |
| SEC-A3 | Access tokens are 15-minute JWTs signed with RS256; refresh tokens are opaque, rotated on every use, and reuse of a consumed refresh token revokes the whole device family. |
| SEC-A4 | Cookies are `httpOnly`, `Secure`, `SameSite=Lax`; CSRF double-submit token on state-changing requests. |
| SEC-A5 | Session revocation propagates to live WebSockets within 5 seconds. |
| SEC-A6 | MFA is the MIS's responsibility, not Tupo's — Tupo holds no credential to protect with a second factor. Administrator MFA is enforced at the MIS. |

### 12.2 Authorization

| ID | Requirement |
|---|---|
| SEC-Z1 | Every request is authorised server-side against space membership, conversation membership and role permissions. UI hiding is never the enforcement mechanism. |
| SEC-Z2 | Permissions are atomic and composable (`message.post`, `message.delete.any`, `member.invite`, `meeting.start`, `meeting.record`, `file.upload`, `admin.export`, …). |
| SEC-Z3 | The **contact policy engine** (FR-USR-6) is enforced at the API layer for DM creation, mention resolution and search. |
| SEC-Z4 | Search results, file downloads and permalink access are all re-authorised at read time — no capability is inferred from possession of an id. |
| SEC-Z5 | Meeting tokens are single-user, single-room, TTL-bounded, and carry only the grants the user's role permits. |
| SEC-Z6 | Object-storage access is exclusively via signed URLs issued after authorisation. |

### 12.3 Data protection

| ID | Requirement |
|---|---|
| SEC-D1 | TLS 1.3 (1.2 minimum) for all external traffic; HSTS with a one-year max-age. |
| SEC-D2 | Encryption at rest for database volumes (EBS encryption), object storage and backups. |
| SEC-D3 | Field-level encryption (AES-256-GCM, keys in AWS KMS or a sealed secret store) for especially sensitive fields such as guardian contact details. |
| SEC-D4 | **E2EE roadmap**: v1 is *encrypted in transit and at rest with server-held keys* — this must be stated plainly to users rather than implied to be end-to-end. Phase 6 introduces optional MLS (RFC 9420) E2EE for DMs and private groups, chosen over per-pair Double Ratchet because group membership changes cost O(log N) instead of O(N). Compliance export is incompatible with E2EE, so E2EE channels are explicitly excluded from admin export and this trade-off is a written policy decision. |
| SEC-D5 | Backups are encrypted, tested by monthly restore drills, and retained 30 days (daily) + 12 months (monthly). |
| SEC-D6 | PII is scrubbed from logs and from error-reporting payloads. |

### 12.4 Application security

| ID | Requirement |
|---|---|
| SEC-P1 | All input validated with Zod at the boundary; no raw request body reaches a query builder. |
| SEC-P2 | Parameterised queries only (Drizzle); dynamic SQL is prohibited. |
| SEC-P3 | User-generated HTML is sanitised server-side (`sanitize-html`) and rendered through a strict allowlist; `dangerouslySetInnerHTML` is banned outside the sanitiser boundary. |
| SEC-P4 | Content-Security-Policy without `unsafe-inline`/`unsafe-eval`; plus `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy`, frame-ancestors lockdown. |
| SEC-P5 | Link unfurling and any server-side fetch is SSRF-protected: DNS resolution checked against private/link-local ranges, redirects capped, timeouts enforced. |
| SEC-P6 | Uploaded files are served from a separate origin with `Content-Disposition: attachment` for non-previewable types, defeating stored-XSS via file. |
| SEC-P7 | Rate limits: 30 messages/min per user per conversation, 10 uploads/min, 5 logins/min per IP, 100 API req/min per key — all sliding-window in Redis, with 429 + `Retry-After`. |
| SEC-P8 | Dependency scanning (`npm audit`, Dependabot) and SAST in CI; builds fail on high-severity findings. |
| SEC-P9 | Secrets come from environment/secret manager only; no secret is ever committed, and CI scans for leaked credentials. |
| SEC-P10 | An external penetration test is completed before production launch, with all high findings closed. |

### 12.5 Privacy & compliance

| ID | Requirement |
|---|---|
| SEC-C1 | Compliance with Rwanda Law N° 058/2021 on personal data protection: lawful basis recorded, data minimisation, subject-access and erasure procedures. |
| SEC-C2 | **Minors' safeguarding.** Student-to-student DMs and student-initiated DMs to staff are governed by the contact policy and may be configured as monitored or disabled. Any monitoring is disclosed in the acceptable-use notice shown at first login. |
| SEC-C3 | Data subject requests (access, correction, deletion) are fulfilled through the admin export/erasure tooling within 30 days. |
| SEC-C4 | Recording requires an explicit, visible in-meeting notice; participants are informed before recording begins. |
| SEC-C5 | Retention policies are documented per data class and enforced automatically, not manually. |
| SEC-C6 | The audit log is append-only, tamper-evident (hash-chained), and separately backed up. |

---

## 13. Non-Functional Requirements

### 13.1 Performance targets

| Metric | Target |
|---|---|
| Message delivery latency (send → recipient render), same region | p50 < 150 ms · p95 < 500 ms · p99 < 1 s |
| REST API response time | p95 < 300 ms · p99 < 800 ms |
| Conversation open (50 messages, cached) | < 300 ms |
| Cold app load (first contentful paint, 3G) | < 2.5 s |
| Search query | p95 < 200 ms |
| Meeting join (click → first frame) | < 3 s |
| File upload start latency | < 1 s to first byte transferred |
| Client JS bundle (initial route, gzipped) | < 250 kB |

### 13.2 Scalability

| Dimension | v1 target | Headroom design |
|---|---|---|
| Registered users | 5,000 | Directory sync is batched and incremental |
| Daily active users | 1,200 | — |
| Peak concurrent WebSockets | 2,000 | ~10k per realtime node; add nodes horizontally |
| Messages/day | 100,000 | Monthly partitions; hot partition stays small |
| Concurrent meetings | 20 rooms / 400 participants | Add SFU nodes; capacity measured in tracks |
| Storage year 1 | 2 TB | Object storage scales independently |

Scaling procedure is documented as a runbook: add stateless `tupo-api`/`tupo-realtime` instances behind the load balancer; move Redis to a replicated pair; promote the PostgreSQL replica if read load dominates.

### 13.3 Availability & reliability

- **99.5% monthly availability** during the academic term for core messaging (≈3.6 h/month budget), excluding announced maintenance windows.
- No single point of failure in the stateless tiers; PostgreSQL has a streaming replica with a documented promotion procedure.
- **RPO ≤ 15 minutes** (WAL archiving), **RTO ≤ 2 hours**.
- Graceful degradation, explicitly designed and tested:
  - MIS unavailable → existing sessions continue; new logins blocked with a clear message.
  - Search unavailable → chat unaffected; search UI shows a degraded-mode notice.
  - SFU unavailable → chat and files unaffected; meetings show "unavailable".
  - Redis unavailable → REST path continues to work; realtime reconnects when Redis returns.
- Health endpoints (`/healthz` liveness, `/readyz` readiness) on every service; the load balancer drains unhealthy instances.
- Zero-downtime deploys: rolling restart with connection draining (realtime nodes tell clients to reconnect before terminating).

### 13.4 Usability & accessibility

- **WCAG 2.1 Level AA** compliance: keyboard operability for every function, visible focus, 4.5:1 contrast, ARIA live regions for incoming messages, screen-reader-announced state changes.
- Full keyboard navigation with documented shortcuts (`Ctrl/Cmd-K` search, `Ctrl/Cmd-/` shortcuts help, `↑` edit last message, `Esc` close thread).
- Mobile-first responsive layouts from 320 px upward, with touch targets ≥ 44 px.
- Light and dark themes, honouring the MIS `preferred_theme` and the OS preference.
- `prefers-reduced-motion` respected throughout.
- Trilingual UI: English, Kinyarwanda, French, with per-user selection.
- New-user onboarding tour and contextual empty states.

### 13.5 Observability

- Structured JSON logs (`pino`) with a correlation id propagated across services and into socket events.
- Prometheus metrics: message throughput, socket connections, event lag, queue depth, DB pool saturation, SFU tracks, upload success rate, error rates by endpoint.
- OpenTelemetry traces across api → worker → database → storage.
- Grafana dashboards per module and alerting on: p95 latency breach, queue depth, error-rate spike, disk/storage threshold, replication lag, certificate expiry, SFU CPU.
- Sentry for client and server exceptions with PII scrubbing and release tagging.

### 13.6 Maintainability

- Monorepo (**npm workspaces** — chosen over pnpm to match the sibling NGA repos and their deploy scripts) with `packages/shared` holding Zod schemas, socket event types and constants used by both client and server, so contract drift is impossible.
- Strict TypeScript (`strict: true`, `noUncheckedIndexedAccess`); ESLint + Prettier enforced in CI.
- Conventional Commits; every change reviewed; migrations are versioned, forward-only and reversible-by-compensation.
- Minimum 70% unit-test coverage on business logic; 100% of auth and permission logic covered.
- Architecture Decision Records for every choice in §5, updated when revisited.

---

## 14. Deployment & Infrastructure

### 14.1 Environments

| Environment | Purpose | Footprint |
|---|---|---|
| Local | Development | Docker Compose: Postgres, Redis, MinIO, Meilisearch, ClamAV. Media uses the real Cloudflare Realtime app — there is nothing to run locally |
| Staging | Integration & UAT, MIS staging SSO | Single `t3.large` running all services |
| Production | Live | See topology below |

### 14.2 Production EC2 topology (recommended starting point)

| Node | Instance | Runs | Notes |
|---|---|---|---|
| **app-1 / app-2** | `t3.large` (2 vCPU / 8 GB) ×2 | `tupo-api`, `tupo-realtime`, `tupo-files`, Nginx | Stateless; behind an ALB with sticky sessions for WebSockets |
| **worker-1** | `t3.medium` | `tupo-worker`, ClamAV, FFmpeg, Meilisearch | CPU-bursty, isolated from request latency |
| **data-1** | `m6i.large` + 200 GB gp3 | PostgreSQL 17 primary, Redis 7 | Encrypted EBS, automated snapshots |
| **data-2** | `t3.medium` + 200 GB gp3 | PostgreSQL streaming replica | Promotion target; also serves analytics reads |
| **Storage** | S3 (or MinIO on EBS) | Files, recordings, backups | Lifecycle rules → Infrequent Access after 90 days |

Estimated steady-state cost at this footprint is roughly **US$450–700/month** including storage and egress, dominated by the SFU node — which can be stopped outside teaching hours if meetings are timetabled.

### 14.3 Network & ports

| Port | Protocol | Service | Exposure |
|---|---|---|---|
| 443 | TCP | Nginx/ALB — HTTPS + WSS | Public |
| 443 | TCP/TLS | coturn TURNS fallback | Public |
| 3478 | UDP/TCP | STUN/TURN | Public |
| 50000–60000 | UDP | SFU media | Public |
| 5190–5194 | TCP | api · realtime · files · worker · web (behind nginx) | localhost only |
| 5432 / 6379 | TCP | PostgreSQL / Redis | VPC security group only |
| 7700 / 3310 | TCP | Meilisearch / clamd | VPC security group only |

### 14.4 CI/CD

```
push → GitHub Actions
   ├─ lint · typecheck · unit tests (Vitest)
   ├─ integration tests (Testcontainers: Postgres, Redis, MinIO)
   ├─ build Docker images, tag with commit SHA
   ├─ deploy to staging → Playwright E2E suite → k6 smoke load test
   └─ manual approval → rolling production deploy
         ├─ run migrations (expand → deploy → contract, never destructive in one step)
         ├─ health-gate each instance before taking the next out of rotation
         └─ automatic rollback to the previous image on health-check failure
```

### 14.5 Backup & disaster recovery

- PostgreSQL: nightly base backup + continuous WAL archiving to S3 (RPO ≤ 15 min); PITR verified monthly.
- Object storage: versioning enabled + cross-region replication for recordings and legal-hold content.
- Redis: ephemeral by design; loss costs presence and counters only, both of which self-heal.
- Configuration and secrets: stored in a secret manager, exported encrypted, restorable from a documented runbook.
- A full DR rehearsal (restore into a fresh VPC) is performed before launch and annually thereafter.

---

## 15. UX / UI Requirements

### 15.1 Information architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│  Tupo   [⌘K search]                        [presence] [bell] [avatar]│
├──────┬───────────────────────┬───────────────────────────────────────┤
│ Rail │  Sidebar              │  Main panel            │  Context     │
│      │                       │                        │  panel       │
│ 💬   │  ▸ Starred            │  Channel header        │              │
│ 📣   │  ▸ Channels           │  ──────────────────    │  Thread /    │
│ 📁   │    # class-4b         │  Virtualized message   │  Members /   │
│ 🎥   │    # staff-room       │  list (reverse scroll) │  Files /     │
│ ✉️   │  ▸ Direct messages    │  "New messages" divider│  Meeting     │
│ ⚙️   │  ▸ Groups             │  ──────────────────    │  details     │
│      │  [+ New]              │  Composer + attach     │              │
└──────┴───────────────────────┴────────────────────────┴──────────────┘
```

- **Desktop** — three panes as above.
- **Tablet** — sidebar collapses to icons; context panel becomes an overlay.
- **Mobile** — one pane at a time with native-feeling push navigation; a bottom tab bar replaces the rail; the composer stays docked above the keyboard.

### 15.2 Design system

| Token group | Definition |
|---|---|
| Colour | Semantic tokens (`--surface`, `--surface-raised`, `--text`, `--text-muted`, `--accent`, `--success`, `--warning`, `--danger`) defined once per theme; the brand accent is a single variable so the forthcoming logo palette drops in without a refactor |
| Typography | One sans stack for UI, one mono for code; a 6-step scale; 1.5 line-height for message bodies |
| Spacing | 4 px base scale |
| Radius | 8 px default, 16 px for bubbles, full for avatars |
| Elevation | Two levels only — flat surfaces, borders over shadows |
| Motion | 150 ms ease-out for micro-interactions, 250 ms for panel transitions, disabled under `prefers-reduced-motion` |

### 15.3 Key interaction requirements

| ID | Requirement |
|---|---|
| UX-1 | Optimistic send: the message appears instantly with a `pending` clock icon, becomes `sent` on ack, and shows an inline retry affordance on failure — it is never silently lost. |
| UX-2 | The message list preserves scroll anchoring when history loads above, and never jumps while the user is reading. |
| UX-3 | A "jump to latest" pill with an unread count appears when the user has scrolled away. |
| UX-4 | Skeleton loaders, never spinners, for list and conversation loading. |
| UX-5 | Connection state is always visible: a subtle banner for "Reconnecting…" and "You are offline — messages will send when you reconnect." |
| UX-6 | Drag-and-drop file upload with a full-panel drop target and per-file progress. |
| UX-7 | Hover/long-press message actions: react, reply in thread, quote, forward, copy link, pin, edit, delete. |
| UX-8 | Emoji picker with search, skin-tone selection, recents and custom space emoji. |
| UX-9 | Unread and mention badges are consistent across sidebar, tab title, favicon and PWA badge, and clear across devices. |
| UX-10 | Meeting pre-join screen is mandatory: device preview and selection before entering. |
| UX-11 | Empty states teach the next action ("No messages yet — say hello to #class-4b"). |
| UX-12 | Destructive actions (delete channel, remove member, end meeting for all) require typed or explicit confirmation. |

---

## 16. Testing & Quality Assurance

| Layer | Tooling | Coverage requirement |
|---|---|---|
| Unit | Vitest | ≥70% overall; 100% of authz, permission and contact-policy logic |
| Integration | Vitest + Supertest + Testcontainers | Every API endpoint, including negative authorization cases |
| Realtime | Socket.IO client harness | Ordering, gap recovery, idempotent retry, multi-device sync, reconnect storms |
| E2E | Playwright | Login → send → receive across two browser contexts; thread; upload; join meeting; feed post |
| Media | Headless Chrome peers driven by Playwright | Two-peer media proven by measured inbound bytes; degradation ladder; TURN-only path with UDP blocked |
| Load | k6 | 2,000 concurrent sockets; 200 messages/s sustained; 500 concurrent uploads |
| Security | OWASP ZAP, `npm audit`, SAST, external pentest | No high findings open at launch |
| Accessibility | axe-core in CI + manual screen-reader pass (NVDA, VoiceOver) | Zero critical violations |
| Resilience | Fault injection | Kill Redis / SFU / a realtime node under load and assert documented degradation |

**Definition of done** for any story: implemented · unit + integration tested · accessible · localised · documented in the API spec · reviewed · deployed to staging and accepted by the product owner.

---

## 17. Delivery Roadmap

| Phase | Duration | Scope | Exit criteria |
|---|---|---|---|
| **0 — Foundations** | 3 weeks | Monorepo, CI/CD, Docker Compose, Postgres schema + migrations, MIS SSO login, design system, app shell | A user can log in with MIS credentials and see an empty, themed, deployed shell |
| **1 — Core chat** | 6 weeks | DMs, groups, channels, messages, threads, reactions, mentions, presence, typing, receipts, unreads, offline queue, realtime layer | Two users exchange messages reliably across devices; all §13.1 latency targets met |
| **2 — Files** | 3 weeks | `tupo-files`, resumable upload, scanning, thumbnails, previews, quotas, files browser | 5 GB file uploads, survives a network drop, is scanned and previewable |
| **3 — Meet (core)** | 5 weeks | Cloudflare Realtime SFU + TURN, instant and scheduled meetings, lobby, screen share, host controls, recording, attendance export | 50-participant meeting held end-to-end with recording and attendance export |
| **4 — Feed & Mail** | 5 weeks | Pages, posts, comments, reactions, polls, moderation; mailbox, distribution lists, bulk announcements, templates | An institution-wide announcement reaches every user by feed, mail and push |
| **5 — Search, notifications, admin** | 4 weeks | Meilisearch integration, notification centre, web push, digests, admin console, audit log, analytics, retention | Admin can search, moderate, export, and set retention; push arrives on mobile PWA |
| **6 — Hardening & launch** | 4 weeks | Load testing, pentest, accessibility audit, i18n completion, DR rehearsal, runbooks, training, pilot with one cohort | Pentest high findings closed; pilot cohort signs off; DR restore rehearsed |
| **7 — Post-launch (backlog)** | ongoing | Breakout rooms, live captions/transcripts, MLS E2EE, native mobile apps, bot framework, external IMAP, message translation | — |

**Indicative total: ~30 weeks (7 months)** for phases 0–6 with a team of 1 tech lead, 2 backend, 2 frontend, 1 DevOps/SRE (part-time), 1 QA, 1 designer (part-time).

**Critical path.** SSO credentials (A-1) block Phase 0; security-group approval for UDP (A-3) blocks Phase 3 testing. Both should be secured during Phase 0 regardless of when they are needed.

---

## 18. Risks & Mitigations

| # | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| R1 | Institutional/ISP firewalls block UDP, breaking meetings | High | High | TURN over TCP/TLS 443 enabled by default and tested as a first-class path, not a fallback afterthought |
| R2 | SFU cost and capacity underestimated for large assemblies | Medium | High | Webinar mode (few publishers, many subscribers) capped in product; capacity measured in tracks and alerted on; SFU node stoppable off-hours |
| R3 | Poor last-mile bandwidth degrades user experience | High | Medium | Aggressive simulcast degradation, audio-only fallback, resumable uploads, offline-first PWA, small initial bundle |
| R4 | MIS SSO outage locks everyone out | Medium | High | Long-lived Tupo sessions, background profile refresh, break-glass admin accounts, clear status messaging |
| R5 | Message ordering or duplication bugs erode trust | Medium | High | Server-allocated `seq`, `nonce` idempotency, explicit gap recovery, dedicated realtime test suite |
| R6 | Safeguarding incident in student messaging | Medium | Severe | Contact policy engine, moderation queue, reporting, retention, audit log, disclosed monitoring policy |
| R7 | Storage growth outpaces budget | Medium | Medium | Quotas, deduplication, retention policies, lifecycle tiering, storage dashboards with alerts |
| R8 | Scope creep from "let's also add…" | High | Medium | This SRS is the baseline; changes go through written change control with schedule impact stated |
| R9 | E2EE expected by stakeholders but not delivered in v1 | Medium | Medium | Stated plainly in §12.3 and in user-facing copy; MLS scheduled and budgeted in Phase 7 |
| R10 | Low adoption because staff keep using WhatsApp | Medium | High | Migrate real workflows first (class channels, announcements, attendance evidence), run training in Phase 6, integrate notifications from TaskMentor so Tupo is where the work already arrives |
| R11 | Socket.IO broadcast amplification at scale | Low | Medium | Per-conversation pub/sub sharding and a session registry from day one; `uWebSockets.js` migration path documented |
| R12 | Key-person dependency on WebRTC knowledge | Medium | Medium | A managed SFU removes the server-operations half of the problem, but the client-side negotiation is ours; runbooks and ADRs required; two engineers trained on the media stack |

---

## 19. Acceptance Criteria

The system is accepted when all of the following are demonstrated on the production infrastructure:

1. **Authentication** — A user signs in with NGA MIS credentials, their roles and class assignments are correctly reflected, and revoking a device terminates its session within 5 seconds.
2. **Messaging** — Two users on different networks exchange messages in a DM, a group and a channel, with p95 delivery under 500 ms; a message composed offline sends automatically on reconnect exactly once.
3. **Threads and reactions** — Threaded discussion, mentions, reactions, editing and deletion behave as specified, with correct unread and mention badges across two devices of the same user.
4. **Files** — A 5 GB file uploads, survives a deliberate network interruption and resumes, is virus-scanned, generates a thumbnail, and is downloadable only by conversation members.
5. **Meet** — A 50-participant meeting runs with screen share, host controls, lobby admission and recording; the recording is retrievable; attendance is exported; the meeting works with UDP blocked at the client.
6. **Feed** — A page publishes a post with images and a poll; comments and reactions stream live to other viewers; a reported post reaches the moderation queue.
7. **Mail** — A bulk announcement to a synced distribution list of 500 recipients is sent, delivery is tracked per recipient, and bounces are recorded.
8. **Search** — A message sent two minutes earlier is found by a misspelled query, and no result from a non-member conversation is ever returned.
9. **Administration** — Retention deletes expired content on schedule; an audit export is produced under two-person authorisation and every privileged action is logged.
10. **Non-functional** — Load test of 2,000 concurrent sockets and 200 messages/s passes within latency targets; accessibility audit shows zero critical violations; pentest high findings are closed; a DR restore is completed within the 2-hour RTO.

---

## 20. Appendices

### 20.1 Appendix A — Environment variables

```ini
# ── tupo-api ──────────────────────────────────────────────
NODE_ENV=production
PORT=4000
APP_URL=https://tupo.amashuri.com
DATABASE_URL=postgres://tupo:***@data-1:5432/tupo
REDIS_URL=redis://data-1:6379/0
JWT_PRIVATE_KEY_PATH=/etc/tupo/keys/jwt.pem
JWT_PUBLIC_KEY_PATH=/etc/tupo/keys/jwt.pub
ACCESS_TOKEN_TTL=15m
REFRESH_TOKEN_TTL=30d

# MIS SSO (see SSO_CLIENT_INTEGRATION.md)
NGA_MIS_BASE_URL=https://mis.amashuri.com
MIS_LOGIN_URL=https://mis.amashuri.com/login
SSO_CLIENT_ID=***
SSO_CLIENT_SECRET=***
SSO_REDIRECT_URI=https://tupo.amashuri.com/sso/callback

# ── tupo-realtime ─────────────────────────────────────────
SOCKET_PORT=4001
REDIS_ADAPTER_URL=redis://data-1:6379/1
PRESENCE_TTL_SECONDS=90

# ── tupo-files ────────────────────────────────────────────
FILES_PORT=4002
S3_ENDPOINT=https://s3.eu-west-1.amazonaws.com
S3_BUCKET=tupo-files-prod
S3_REGION=eu-west-1
S3_ACCESS_KEY_ID=***
S3_SECRET_ACCESS_KEY=***
MAX_FILE_SIZE_BYTES=5368709120
SIGNED_URL_TTL_SECONDS=900
CLAMAV_HOST=worker-1
CLAMAV_PORT=3310

# ── tupo-sfu / meet ───────────────────────────────────────
CLOUDFLARE_REALTIME_APP_ID=***
CLOUDFLARE_REALTIME_APP_SECRET=***
CLOUDFLARE_TURN_TOKEN_ID=***
CLOUDFLARE_TURN_API_TOKEN=***
TURN_URLS=turn:turn.tupo.amashuri.com:3478,turns:turn.tupo.amashuri.com:443
TURN_SHARED_SECRET=***

# ── worker / search / mail / push ─────────────────────────
MEILISEARCH_HOST=http://worker-1:7700
MEILISEARCH_MASTER_KEY=***
SMTP_HOST=email-smtp.eu-west-1.amazonaws.com
SMTP_USER=***
SMTP_PASS=***
MAIL_FROM="NGA Tupo <no-reply@amashuri.com>"
VAPID_PUBLIC_KEY=***
VAPID_PRIVATE_KEY=***

# ── tupo-web ──────────────────────────────────────────────
VITE_API_URL=https://tupo.amashuri.com/api/v1
VITE_SOCKET_URL=wss://tupo.amashuri.com
VITE_MIS_LOGIN_URL=https://mis.amashuri.com/login
VITE_SSO_CLIENT_ID=***
```

### 20.2 Appendix B — Repository layout

```
nga-communication-module/
├── apps/
│   ├── web/                 # React + Vite + Tailwind PWA
│   ├── api/                 # Express REST service
│   ├── realtime/            # Socket.IO gateway
│   ├── files/               # File service (tus + S3/MinIO)
│   └── worker/              # BullMQ processors
├── packages/
│   ├── shared/              # Zod schemas, socket event types, constants
│   ├── db/                  # Drizzle schema + migrations
│   ├── ui/                  # shadcn-based component library
│   └── config/              # eslint, tsconfig, tailwind presets
├── infra/
│   ├── docker/              # Dockerfiles + compose files
│   ├── nginx/
│   └── runbooks/
├── docs/
│   ├── TUPO_SRS.md          # this document
│   ├── adr/                 # architecture decision records
│   └── api/                 # generated OpenAPI + AsyncAPI
└── .github/workflows/
```

### 20.3 Appendix C — Traceability summary

| Module | Requirement range | Phase | Acceptance item |
|---|---|---|---|
| Auth & identity | FR-AUTH-1…9, FR-USR-1…8 | 0, 1 | 1 |
| Chat | FR-CHN-1…10, FR-MSG-1…26 | 1 | 2, 3 |
| Files | FR-FILE-1…15, FS-1…10 | 2 | 4 |
| Meet | FR-MEET-1…20 | 3 | 5 |
| Feed | FR-FEED-1…12 | 4 | 6 |
| Mail | FR-MAIL-1…11 | 4 | 7 |
| Notifications | FR-NOTIF-1…8 | 5 | 6 |
| Search | FR-SRCH-1…7 | 5 | 8 |
| Admin | FR-ADM-1…11 | 5 | 9 |
| Integrations | FR-INT-1…6 | 4, 5 | — |
| Security | SEC-A/Z/D/P/C | all | 10 |

### 20.4 Appendix D — Research sources

**Databases and chat data modelling**
- [Database Architecture for Real-Time Chat — GetStream](https://getstream.io/blog/chat-app-database/)
- [Chat Application Architecture — scalability, message ordering — GetStream](https://getstream.io/blog/chat-application-architecture/)
- [MongoDB or PostgreSQL for your chat app — Inside of Code](https://insideofcode.com/which-is-better-for-your-chat-app-mongodb-or-postgresql/)
- [Best Database for a Chat App — Layerbase](https://layerbase.com/blog/best-database-for-a-chat-app)
- [System Design: Chat Application (WhatsApp/Slack)](https://www.techinterview.org/post/3233465319/system-design-chat-application/)
- [Design a Chat Application — Design Gurus](https://www.designgurus.io/blog/design-chat-application)

**Realtime transport**
- [Scaling Socket.IO — Ably](https://ably.com/topic/scaling-socketio)
- [Scaling Socket.IO: Redis adapters and namespace partitioning](https://medium.com/@connect.hashblock/scaling-socket-io-redis-adapters-and-namespace-partitioning-for-100k-connections-afd01c6938e7)
- [socket.io issue #5226 — better network scaling with adapters](https://github.com/socketio/socket.io/issues/5226)
- [Socket.IO vs ws vs uWebSockets.js 2026 — PkgPulse](https://www.pkgpulse.com/guides/socketio-vs-ws-vs-uwebsockets-websocket-servers-nodejs-2026)

**WebRTC media servers**
- [Best Open Source WebRTC Media Servers (SFU) 2026 — BlogGeek.me](https://bloggeek.me/webrtc-tools/media-servers-oss/)
- [Cloudflare Realtime SFU — API reference](https://developers.cloudflare.com/realtime/https-api/)
- [Cloudflare Realtime TURN](https://developers.cloudflare.com/realtime/turn/)
- [Choosing an SFU: mediasoup, Janus, LiveKit, Jitsi, Pion — Fora Soft](https://www.forasoft.com/learn/video-streaming/articles-streaming/sfu-comparison-mediasoup-janus-livekit-jitsi-pion)
- [Perfect negotiation — MDN](https://developer.mozilla.org/en-US/docs/Web/API/WebRTC_API/Perfect_negotiation)
- [WebRTC TURN scaling: coturn vs Cloudflare (2026) — Callsphere](https://callsphere.ai/blog/vw3e-webrtc-turn-scaling-coturn-vs-cloudflare-2026)

**Encryption**
- [RFC 9420 — The Messaging Layer Security (MLS) Protocol](https://www.rfc-editor.org/rfc/rfc9420.html)
- [RFC 9420 aka MLS — an overview](https://blog.phnx.im/rfc-9420-mls/)
- [RFC 9420: Messaging Layer Security — Feisty Duck](https://www.feistyduck.com/newsletter/issue_103_rfc_9420_messaging_layer_security)

**File pipeline**
- [File Upload Pipeline — Practical System Design Guide](https://sysdesign.wiki/guides/file-upload-pipeline/)
- [Designing S3 file storage: presigned URLs, virus scanning, CDN delivery](https://dev.to/myougatheaxo/designing-s3-file-storage-with-claude-code-presigned-urls-virus-scanning-cdn-delivery-5da9)
- [Scanning files with ClamAV — Instil](https://instil.co/blog/scanning-files-with-clamav-and-cdk)
- [ClamAV as a REST application on AWS ECS](https://dev.to/aws-builders/clamav-anti-virus-as-a-rest-application-on-aws-ecs-1d0e)

**Feed and search**
- [Design a News Feed System — ByteByteGo](https://bytebytego.com/courses/system-design-interview/design-a-news-feed-system)
- [News Feed System Design: fan-out strategies & ranking — Codelit](https://codelit.io/blog/news-feed-system-design)
- [Postgres full-text search vs the rest — Supabase](https://supabase.com/blog/postgres-full-text-search-vs-the-rest)
- [Meilisearch vs PostgreSQL full-text search](https://www.meilisearch.com/docs/resources/comparisons/postgresql)
- [Elasticsearch vs Typesense vs Meilisearch](https://www.jusdb.com/blog/elasticsearch-vs-typesense-vs-meilisearch)

**Frontend**
- [My React ecosystem stack in 2026 — Felipe Gustavo](https://www.felgus.dev/blog/react-stack-2026)
- [Best React libraries and tools in 2026 — jsdev.space](https://jsdev.space/react-stack-2026/)
- [React state management 2026: Zustand vs Jotai vs TanStack Query](https://vucense.com/dev-corner/react-state-management-2026/)
- [React Virtuoso](https://virtuoso.dev/)
- [Frontend system design: building a web chat application](https://dev.to/vishwark/frontend-system-design-deep-dive1-building-a-web-chat-application-5c8j)
- [Offline-first PWAs for enterprise with React](https://medium.com/@Modexa/offline-first-pwas-for-enterprise-with-react-6fe3bbbdfefc)

---

*End of document — Tupo SRS v1.0. Changes to this baseline require written change control.*
