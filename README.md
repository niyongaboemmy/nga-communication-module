# Tupo

> **Setting this up on your machine?** Start with **[LOCAL_SETUP.md](LOCAL_SETUP.md)** — it covers the whole local stack, including the Central MIS sign-in every module depends on.

Unified communication platform for the NGA ecosystem — chat, meetings, files, mail and an institutional feed.

Part of the NGA Digital Ecosystem alongside **NGA Central MIS**, **TaskMentor** and **Discipline & Attendance**.

- [Software Requirements Specification](docs/TUPO_SRS.md)
- [Phase 0 implementation plan](docs/IMPLEMENTATION_PLAN.md)
- [Phase 3 — Meet implementation plan](docs/MEET_IMPLEMENTATION_PLAN.md)

---

## Tupo has no login of its own

There is no password field, no registration and no local credential anywhere in this codebase. Every user
authenticates against the **NGA Central MIS** over OAuth2, exactly as TaskMentor and Discipline &
Attendance do. Tupo mints its own *session* after the MIS has vouched for the user, but it never mints an
*identity*.

`apps/api/src/__tests__/noLocalAuth.test.ts` enforces this in CI. If someone adds a password column or a
`/login` route, that test fails on purpose.

---

## Quick start

Requires Node 22+, PostgreSQL 17 and Redis. (`docker compose -f infra/docker/docker-compose.yml up -d`
provides both, plus the MinIO/Meilisearch dependencies later phases need. Meet's media
server is Cloudflare Realtime — an API, so there is nothing to run for it.)

```bash
npm install

# Copy the env templates, then set a single shared JWT_SECRET across api/realtime/files —
# all three verify the same session token, so it must be byte-identical in each.
for a in api realtime files worker web; do cp -n apps/$a/.env.example apps/$a/.env; done
cp -n packages/db/.env.example packages/db/.env   # used by the migrate/seed scripts

createdb tupo_dev
npm run db:migrate
npm run db:seed

npm run dev
```

Then open **http://localhost:5194** and check **/app/system** for live service health.

## Ports

| Service | Port | Purpose |
|---|---|---|
| `@tupo/api` | 5190 | REST, SSO exchange, session issuing |
| `@tupo/realtime` | 5191 | Socket.IO gateway |
| `@tupo/files` | 5192 | Upload / download |
| `@tupo/worker` | 5193 | Background jobs |
| `@tupo/web` | 5194 | Vite dev server (proxies all of the above) |

`npm run preflight` checks these are free before starting. It uses `netstat` rather than `lsof` on
purpose: `lsof` run as a normal user cannot see sockets owned by other users, so a root-owned process
squatting on a port reports as "free" and the service then dies with a confusing `EADDRINUSE`.

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Preflight, then start all five apps |
| `npm run dev:backend` | Backend services only |
| `npm run build` | Build every workspace |
| `npm run typecheck` | Type-check every workspace |
| `npm test` | Unit + integration tests (needs PostgreSQL; uses a throwaway `tupo_test` database) |
| `npm run verify` | Runtime acceptance checks against a running stack (socket auth, job queue, file round-trip) |
| `npm run health` | Curl every service's `/health` |
| `npm run e2e` | Two-ended SSO + RBAC test against a running NGA Central MIS |
| `npm run meet:create-sfu` | Create a Cloudflare Realtime SFU app and save its credentials — `-- <accountId> <apiToken>` |
| `npm run meet:check-sfu` | Prove the Cloudflare Realtime credentials against the live API. Pass `<appId> <secret>` to try a pair before saving them |
| `npm run verify:meet` | Meet acceptance checks against a running stack — real TURN, two live sockets, real AI calls |
| `npm run verify:meet:ui` | Drives a real two-participant meeting in Chromium (needs `npx playwright install chromium`) |
| `npm run db:migrate` / `db:seed` | Apply migrations / seed the institutional spaces |

## Layout

```
apps/api        Express REST API + SSO exchange
apps/realtime   Socket.IO gateway (same session JWT as the API)
apps/files      Upload/download service, pluggable storage driver
apps/worker     BullMQ processors
apps/web        React + Vite + Tailwind PWA
packages/shared Zod schemas, socket event contracts, role derivation
packages/db     Drizzle schema, SQL migrations, snowflake ids
infra/          docker-compose + nginx
```

## Meet

Video meetings live at `/app/meet` — scheduled or instant, with a pre-join device check, a
waiting room, host controls, in-meeting chat, polls, Q&A, breakout rooms, and an AI notetaker.
See [the plan](docs/MEET_IMPLEMENTATION_PLAN.md) for the full design.

**The media server is Cloudflare Realtime**, and there is nothing to run for it — no
container, no UDP port range, no TURN companion. It is the same Cloudflare account as the
TURN credentials Meet already uses, and TURN is free alongside it.

Either create the app from the command line:

```bash
npm run meet:create-sfu -- <accountId> <apiToken>
```

…where the API token is an ordinary account token with **Account · Calls · Edit**
(dash.cloudflare.com/profile/api-tokens → Create Token → Custom). It is used for that one
call and never stored; what gets saved is the App ID and App Secret it returns, verified
against a real session first.

Or create it by clicking, at
[Realtime → SFU](https://dash.cloudflare.com/?to=/:account/realtime/sfu), and hand the two
values over:

```bash
npm run meet:check-sfu <appId> <appSecret>   # proves them, then saves them
npm run meet:check-sfu                       # re-check what is configured
```

The App Secret never reaches the browser. **A TURN key is not an SFU app** — they are
separate resources under Realtime, and pasting one where the other belongs is the mistake
`meet:check-sfu` exists to catch in a second rather than mid-lesson.

**Media transport is pluggable, and that is deliberate.** Everything except the video itself —
the roster, the lobby, host commands, chat, captions, polls, the AI — is carried by
`tupo-realtime` and behaves identically whichever is in use:

| Transport | When | Capacity |
|---|---|---|
| **cloudflare** | `CLOUDFLARE_REALTIME_APP_*` set. The default. | **500 video / 2,000 audio-only** |
| **mesh** | No media server configured | 4 — the API refuses a larger meeting and says what to set |

Cloudflare's SFU has no concept of a room: it is a pub/sub of sessions and tracks, and the
application decides who subscribes to what. That suits Tupo, which already owns the roster —
track names are *derived* from the participant id and never exchanged, so the only thing that
has to travel is each publisher's session id.

**Subscription is demand-driven**, and that is what makes a large meeting work: the roster may
hold four hundred people while the stage renders twenty-five, so tracks are pulled as tiles
appear and closed as they leave. Audio is treated differently from video — you want to hear
people you cannot see. The whole module still runs and tests on a laptop with no media server
at all, on the peer-to-peer transport.

**The app secret never reaches the browser.** Every SFU call is proxied through
`/api/meet/:id/sfu`, which authorises it against the meeting first: a subscriber may only pull
tracks belonging to participants actually in that meeting, under names this application
generated.

**Bandwidth is the design constraint**, because school connections are the deployment target.
Simulcast publishes three rungs (180p/360p/720p); dynacast pauses any rung nobody is watching;
each tile reports its own rendered width so a 160px thumbnail is served 180p and an off-screen
tile is served nothing; and only the top 25 by active-speaker order carry video at all.

**Captions cost nothing.** Each participant transcribes *their own microphone* with the
browser's `SpeechRecognition` and ships text. Speaker attribution is therefore structural
rather than inferred — no diarization, no speech-to-text bill, and a caption is ~80 bytes.

**Who can join** is one of four levels — people with the meetings permission,
invitees only, anyone signed in, or anyone with the link (guests type a name and
always wait in the lobby; no account is ever created for them). **Notes** are
yours: type them, capture the last 45 seconds of transcript with one tap, or ask
the AI to tidy up what you wrote — reversibly, since the original is kept.
**Chat** is one thread per person plus the room. **Presenting** offers a source
choice before the browser's own dialog and shows a persistent "you are
presenting" bar. And **minimising** keeps the call alive in a draggable floating
window while you use the rest of Tupo.

**Every meeting is proposed a name** from its date and time, editable anywhere
it appears. **Recording** works with or without a media server — the SFU
composites it when there is one, the host's browser does when there is not, and
either way it lands in `meetings/<id>/` alongside the rest of that meeting's
media. **Deleting** a meeting belongs to the person who created it and nobody
else; co-hosts and administrators can end or cancel one instead.

**Notifications** arrive as a toast, a synthesised chime, an optional spoken
announcement, and — only when the tab is hidden — a system notification. Your
own actions are confirmed separately and more quietly: a notification tells you
something you did not know, a confirmation closes a loop you opened.

**AI is off until a host turns it on**, is announced in the room while it runs, needs the
`MEET_AI_USE` permission (which Students do not hold), and records which of the four providers
answered on every artifact it produces. It runs through the same
`openai → gemini → groq → glm` fallback chain as TaskMentor and the MIS.

NAT traversal uses **Cloudflare Realtime TURN** — the same integration TaskMentor's proctoring
module uses. Credentials are minted server-side per join and cached; without them, calls work
only on networks that do not block UDP.

## Roles & permissions

Authorization is Tupo's own, modelled on `nga-discipline-attendance`: **60 permissions across 12
categories**, five seeded system roles (Student, Parent, Staff, Moderator, Admin), and custom roles
an administrator can create at `/app/admin/roles`.

- A user's permissions are **resolved from the database on every request**, never read from the
  session token — so a role change takes effect immediately, with no re-login.
- `role_id IS NULL` means *unassigned*: authenticated, but holding nothing, and shown a "pending
  access" screen. There is deliberately no default role for an unrecognised account.
- The server is the only enforcer (`authorizePermission` and friends). `usePermissions()` on the
  client hides controls for tidiness; it is never what keeps anyone out.
- Students do **not** get `DM_START` by default — a safeguarding decision, covered by its own test.

## Before this can authenticate a real user

Tupo is already registered on the **local** MIS (`System` table, `client_id = tupo`, `system_id 5`) with
these redirect URIs:

- dev — `http://localhost:5194/sso/callback`
- prod — `https://tupo.amashuri.com/sso/callback`

For production, register the same client on the production MIS and issue a fresh secret into
`apps/api/.env`. Run `npm run e2e` with the MIS running to verify a deployment end to end.
