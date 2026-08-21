# Tupo — Phase 0 Implementation Plan (Project Setup)

**Scope:** the Phase 0 "Foundations" row of the [SRS](TUPO_SRS.md) roadmap — a running, deployable, MIS-integrated skeleton. No product features; everything after this builds on top.

**Governing constraint:** Tupo has **no login of its own**. There is no password field, no registration, no local account table used for authentication, and no "forgot password". Identity comes from NGA Central MIS via SSO, exactly as TaskMentor and Discipline & Attendance do it.

---

## 1. What "integrated like TaskMentor and Discipline" actually means

The two sibling apps share one concrete integration contract. Tupo copies it rather than inventing a variant, so the three apps behave identically for users and for operators.

| Step | Mechanism | Sibling reference |
|---|---|---|
| 1. Kick off | Client redirects to `VITE_MIS_LOGIN_URL?client_id=…&redirect_uri={origin}/sso/callback` | `client/src/context/AuthContext.tsx → login()` |
| 2. Return | MIS redirects back to `/sso/callback?code=…` | `client/src/pages/SSOCallback.tsx` |
| 3. Exchange | Client POSTs `{code}` to **its own** backend `/api/sso/exchange`; the backend calls MIS `POST /sso/token` with `client_id` + `client_secret` | `server/src/routes/sso.ts` |
| 4. Hydrate | Backend calls MIS `GET /users/me` for profile, permissions, academic period, `systems` | `server/src/utils/misAcademics.ts`, `routes/sso.ts → /systems` |
| 5. Session | Backend signs **its own** 24 h JWT that *embeds the MIS token* (`misToken`) and returns `{token, user, permissions, rolePermissions}` | `routes/sso.ts` |
| 6. Authorise | `authMiddleware` verifies the local JWT and resolves role/permissions **fresh from the DB on every request** | `server/src/middleware/auth.ts` |
| 7. Stay in sync | Client polls `/api/sso/verify-mis` every 3 min; a dead MIS session kills the local one (fails **closed**) | `AuthContext` + `routes/sso.ts` |
| 8. App switcher | `/api/sso/systems` proxies MIS `/users/me` → `systems[]`; `/api/sso/authorize` proxies MIS authorize so hopping apps needs no re-login (fails **open**) | `routes/sso.ts` |
| 9. Theme | `preferred_theme` from the MIS payload sets light/dark on first load | `AuthContext` |

**Role derivation.** The MIS is permission-based and returns no role field, so each app infers its own role from the MIS permission strings (most-privileged-first) and persists it locally, where an admin-assigned role becomes sticky. Tupo reuses this logic with communication-appropriate role names.

### 1.1 Correction to the SRS

The SRS lists `FR-AUTH-7` (break-glass local admin accounts with TOTP). **That is struck** — it is a second login path, which this instruction forbids. Bootstrap administrators are instead handled the sibling way: an `ADMIN_USERNAMES` / `ADMIN_EMAILS` allowlist that *elevates a user who has already authenticated through the MIS*. No credential ever lives in Tupo.

---

## 2. Repository layout to be created

```
nga-communication-module/
├── package.json                 # npm workspaces root + orchestration scripts
├── apps/
│   ├── api/                     # Express — REST, SSO exchange, session issuing   :5190
│   ├── realtime/                # Socket.IO gateway — JWT handshake, presence     :5191
│   ├── files/                   # Upload/download service, pluggable storage      :5192
│   ├── worker/                  # BullMQ processors + health probe                :5193
│   └── web/                     # React + Vite + Tailwind PWA                     :5194
├── packages/
│   ├── shared/                  # Zod schemas, socket event types, envelope, roles
│   ├── db/                      # Drizzle schema + migrations + pool
│   └── config/                  # shared tsconfig base
├── infra/
│   ├── docker/docker-compose.yml    # postgres · redis · minio · meilisearch
│   └── nginx/tupo.conf              # modelled on deploy/nginx-tendo.conf
└── docs/
    ├── TUPO_SRS.md
    └── IMPLEMENTATION_PLAN.md
```

**Tooling decision — npm workspaces, not pnpm.** The SRS suggested pnpm; the sibling apps, the deploy scripts and the team's muscle memory are all plain npm. Consistency across the four NGA repos is worth more than pnpm's disk savings here. *(SRS Appendix B updated to match.)*

**Module system.** ESM throughout (`"type": "module"`, `NodeNext`), with `.js` extensions on relative imports — the same convention as `nga-discipline-attendance/server`.

---

## 3. Port map

Chosen to avoid every port already in use across the ecosystem (MIS, TaskMentor 5001, Discipline 5171/3000, MIS frontend 5173) — and, after the incident recorded in §9, verified with `netstat` rather than `lsof`.

| Service | Port | Health endpoint |
|---|---|---|
| `@tupo/api` | 5190 | `GET /health` |
| `@tupo/realtime` | 5191 | `GET /health` |
| `@tupo/files` | 5192 | `GET /health` |
| `@tupo/worker` | 5193 | `GET /health` |
| `@tupo/web` (Vite) | 5194 | `/` |
| PostgreSQL | 5432 | database `tupo_dev` |
| Redis | 6379 | db 0 (cache/pubsub), db 1 (queues) |

The web dev server proxies `/api` → 5190, `/files` → 5192 and `/socket.io` → 5191, so the browser only ever talks to one origin — the same same-origin approach Discipline uses, which is why its nginx config needs the `/api/` proxy block.

---

## 4. Work breakdown

### Step 1 — Workspace root
Root `package.json` with workspaces, `concurrently`-driven `dev`, and `build` / `typecheck` / `test` / `db:migrate` fan-out. Shared `tsconfig.base.json`, `.editorconfig`, `.gitignore` additions, `.env.example` per app.

### Step 2 — `packages/shared`
Zod-validated env loader (fails fast on missing `SSO_CLIENT_SECRET` in production), the `{success, data, message}` response envelope used by every NGA app, role types, permission keys, and the typed socket event catalogue from SRS §9.2. Both client and server import from here so the contract cannot drift.

### Step 3 — `packages/db`
Drizzle schema for the Phase 0 subset of SRS §7: `users`, `user_devices`, `spaces`, `space_members`, `conversations`, `conversation_members`, `messages` (partition-ready), `audit_log`. Migration runner + `db:migrate` / `db:seed` scripts. Snowflake ID generator.

**No credential columns.** `users` stores `mis_user_id`, name, email, avatar, role and last-login only. There is deliberately no `password_hash`, and a test asserts that.

### Step 4 — `apps/api`
- `app.ts` (no side effects, importable by supertest) + `index.ts` (starts DB then listens) — the Discipline split, which is what makes their tests fast.
- `routes/sso.ts`: `POST /exchange`, `GET /verify-mis`, `GET /systems`, `GET /authorize` — behaviour-identical to the sibling implementation, including the per-IP rate limiter on `/exchange` and the fail-closed/fail-open split.
- `middleware/auth.ts`: verifies the local JWT, re-resolves role and permissions from the DB per request, returns 401 (not 403) for a dangling session.
- CORS allowlist, security headers, `express.json` limit, `GET /health`.

### Step 5 — `apps/realtime`
Socket.IO server authenticating the **same** local JWT in the handshake, Redis adapter wired, `ping`/`presence:set` implemented as the proof-of-life events, `/health` over HTTP. Rooms and the full event catalogue land in Phase 1.

### Step 6 — `apps/files`
Express service with a `StorageDriver` interface and two implementations — `local` (dev default, no MinIO needed) and `s3` (production) — selected by `STORAGE_DRIVER`. Phase 0 ships upload ticket issuing, direct upload, metadata row and signed-ish download, with scanning/thumbnails deferred to Phase 2.

### Step 7 — `apps/worker`
BullMQ connection, one registered no-op `heartbeat` job proving Redis wiring end to end, plus a health probe so the process is observable.

### Step 8 — `apps/web`
Vite + React 19 + TypeScript + Tailwind 4 + React Router 7.
- `/` — a landing screen whose **only** action is "Sign in with NGA MIS". No form.
- `/sso/callback` — exchanges the code, mirrors the Discipline callback including the Strict-Mode double-exchange guard.
- `AuthContext` — session restore, MIS-session polling, theme from `preferred_theme`, logout.
- `ProtectedRoute` + an app shell with the rail/sidebar/main layout from SRS §15.1, and a `/system` page that live-checks every backend health endpoint.

### Step 9 — Infra & docs
`docker-compose.yml` for the full dependency set (usable when Docker is running; local Postgres/Redis work without it), nginx config modelled on `deploy/nginx-tendo.conf` — including the `large_client_header_buffers` fix the siblings needed because the nested `misToken` blows past nginx's default header buffer — and a README with the run book.

### Step 10 — Verification
Documented in §6 below; this is the acceptance gate for Phase 0.

---

## 5. Configuration

`.env.example` per app; real `.env` files are git-ignored. The values that must come from the MIS team before anything works end to end:

```ini
SSO_CLIENT_ID=tupo
SSO_CLIENT_SECRET=<issued by MIS admin dashboard>
NGA_MIS_BASE_URL=https://mis.amashuri.com
VITE_MIS_LOGIN_URL=https://mis.amashuri.com/login
# Registered redirect URI (dev):  http://localhost:5194/sso/callback
# Registered redirect URI (prod): https://tupo.<domain>/sso/callback
```

Until the client secret is issued, everything except the live token exchange is testable — which is why Step 10 verifies the exchange path with a mocked MIS as well as against the real one.

---

## 6. Verification plan (Phase 0 exit criteria)

| # | Check | Method |
|---|---|---|
| V1 | Every workspace type-checks | `npm run typecheck` — zero errors |
| V2 | Every app builds | `npm run build` — all five emit output |
| V3 | Migrations apply to a clean DB | `npm run db:migrate` against a fresh `tupo_dev` |
| V4 | All four backends boot and report healthy | `npm run dev` then `curl` each `/health` |
| V5 | Web dev server serves the app and proxies `/api` | `curl` the Vite origin and a proxied API route |
| V6 | Realtime accepts an authenticated socket and rejects an unauthenticated one | Socket.IO client script, both cases |
| V7 | Redis wiring works end to end | Enqueue `heartbeat`, assert the worker processes it |
| V8 | File upload/download round-trips on the local driver | `curl` ticket → upload → download, compare checksums |
| V9 | SSO exchange behaves correctly against a mocked MIS | Vitest + supertest: success, bad code, MIS down, rate limit |
| V10 | **No local authentication exists** | Test asserting no password column, no `/login` route, no credential handler |
| V11 | A protected route rejects a request with no/invalid token | Supertest 401 assertions |
| V12 | Ports collide with nothing else in the ecosystem | `npm run preflight` (netstat-based) before boot |

---

## 7. Risks specific to this phase

| Risk | Mitigation |
|---|---|
| SSO client credentials not yet issued → cannot test the real exchange | Mocked-MIS test suite gates the code; a one-line env change flips to live |
| Redirect URI must be pre-registered in the MIS admin dashboard | Request `http://localhost:5194/sso/callback` **and** the production URL together, in Phase 0 |
| Docker not running on dev machines | Local Postgres/Redis are sufficient; compose file is convenience, not a dependency |
| Nested `misToken` overflows nginx header buffers in production | `large_client_header_buffers 8 32k` shipped in the nginx config from day one, learned from Discipline |
| Node 25 vs Node 22 LTS drift between dev and EC2 | `engines` field + `.nvmrc` pinned to 22 |

---

## 8. What actually happened during setup

Recorded because each of these cost real time and will otherwise be rediscovered.

| Finding | Impact | Resolution |
|---|---|---|
| **`lsof` lies about port availability.** The API's first port, 5180, was held by an unrelated **root-owned** MAMP Vite server. `lsof` run as a normal user cannot see other users' sockets, so the port reported as free and the API then died with a bare `EADDRINUSE`. | Lost boot, confusing error | Whole block moved to 5190–5194; `npm run preflight` now checks with `netstat`, and both the API and files service print an actionable message instead of a stack trace. |
| **The file service stored zero bytes while reporting a correct checksum.** Hashing the upload with `req.on('data')` put the request stream into flowing mode, draining it before `pipeline()` attached the write stream. The checksum matched because it was computed from the drained chunks. | Silent data loss — the worst possible failure mode for a file service | Hashing moved *inside* the pipeline as a `Transform` stage, so bytes cannot be consumed twice. A zero-byte upload is now rejected outright, and the acceptance check asserts size alongside checksum so this can never pass again. |
| **BullMQ rejects `:` in queue names** (it reserves the character as its Redis key separator). | Worker crashed on boot | Queue renamed `tupo-jobs`. |
| **Tailwind 4 resolves `dark:` from `prefers-color-scheme` by default**, ignoring the app's own toggle and the `preferred_theme` carried from the MIS. | Theme switch would silently not work | `@custom-variant dark` bound to the `data-theme` attribute; `data-theme` is now the single source of truth. |
| **Compiled `dist/` copies of test files ran alongside the sources**, fighting over the global `fetch` stub and inflating test counts. | One flaky-looking failure, doubled counts | Vitest `include` limited to `src/**/*.test.ts` in every workspace. |
| **`npm audit` reported 6 vulnerabilities on the initial dependency set** (drizzle-orm SQL injection; vite/vitest/esbuild dev-server issues). | Would fail SEC-P8 at the first CI run | Bumped drizzle-orm 0.45.2, vitest 4.1.11, vite 8.2.1 deliberately rather than `--force`. Now **0 vulnerabilities**. |
| **`npm run db:migrate` failed from a clean clone** — `packages/db` had no env of its own. | Broken quick-start | Added `packages/db/.env.example`, and the error now names the file to copy. |
| **The web `typecheck` script was broken** and masked by a `||` fallback, so it always exited 0. | Type errors would ship silently | Replaced with a plain `tsc -p tsconfig.json --noEmit`. |

## 9. Phase 0.5 — Role-based access management

Delivered on top of the Phase 0 skeleton, modelled on `nga-discipline-attendance`'s RBAC so the three apps are administered identically.

### Model

`roles` ──< `role_permissions` >── `permissions`, with `users.role_id` pointing at exactly one role. `role_id IS NULL` means **unassigned** — a real state, not a fallback: the user is authenticated but holds nothing and sees a "pending access" screen until an administrator acts. Guessing a default role for an unrecognised account is precisely the mistake a school platform cannot afford.

**Permissions are resolved from the database on every request, never read from the token.** A role change therefore lands on the user's very next request rather than at their next login — proven by an end-to-end test that demotes a live session and watches the same token go 200 → 403 → 200.

### Catalog — 60 permissions in 12 categories

*(58 at Phase 0.5; Phase 3 added `MEET_TRANSCRIBE` and `MEET_AI_USE`.)*

| Category | Permissions | Category | Permissions |
|---|---|---|---|
| Messaging | 9 | Moderation & Safety | 4 |
| Channels & Groups | 7 | Administration | 9 |
| Meetings | 9 | Roles & Permissions | 2 |
| Files | 5 | Directory & Presence | 3 |
| Feed & Posts | 5 | Notifications | 1 |
| Mail | 5 | Account Settings | 1 |

Defined once in `packages/shared/src/permissions.ts` and seeded idempotently by `packages/db/src/rbac.ts`, which also **retires** keys dropped from the catalog so a removed permission cannot linger on a role and keep granting access.

### Seeded roles

| Role | Level | Permissions | Notes |
|---|---|---|---|
| Student | STUDENT | 19 | **No `DM_START`.** A safeguarding default (SRS FR-USR-6), enforced by its own test so it cannot be silently changed. |
| Parent | PARENT | 19 | May contact staff. |
| Staff | STAFF | 36 | Runs channels, meetings, announcements. |
| Moderator | STAFF | 40 | Adds the moderation queue, `MESSAGE_DELETE_ANY`, audit access. |
| Admin | ADMIN | 60 | Everything. |

### Enforcement

- **Server (authoritative):** `authorizePermission` / `authorizeAllPermissions` / `selfOrPermission` guard every protected route.
- **Client (cosmetic only):** `usePermissions()` hides rail icons and buttons. Hiding a control is never what keeps a user out — each route is independently authorised, and the tests assert 403 rather than 404.
- **Lockout protection:** the last active administrator cannot strip their own role or suspend themselves.
- **Sticky assignment:** once an administrator sets a role by hand, `role_assigned_by_admin` stops a later MIS login recomputing it.

### MIS client registration

Tupo is registered in the local MIS (`System` table, MAMP MySQL on 8889) as `system_id 5`:

```
client_id             tupo
allowed_redirect_uris http://localhost:5194/sso/callback,
                      https://tupo.amashuri.com/sso/callback
home_url              http://localhost:5194
status                ACTIVE
```

The generated client secret lives only in `apps/api/.env` (git-ignored). The MIS's own `POST /sso/clients` endpoint does the same thing for other environments.

### Design alignment

Tupo now uses the MIS design language so the apps look like one product: **blue-600** primary, slate neutrals, Inter at a 15px base with JetBrains Mono, `rounded-lg`/`xl`, and dark mode via a `.dark` class on `<html>` (matching the MIS's `darkMode: "class"`). Shared primitives live in `apps/web/src/components/ui.tsx`. The cross-app "waffle" switcher is fed by the MIS's own systems list, exactly as TaskMentor and Tendo do it.

### Domain migration

`nga.ac.rw` is retired throughout. Everything now hangs off **amashuri.com** subdomains: `mis.amashuri.com`, `taskmentor.amashuri.com`, `tendo.amashuri.com`, `tupo.amashuri.com` (plus `meet.` and `turn.` for the SFU).

## 10. Definition of done

Phase 0 is complete when V1–V12 pass, `npm run dev` brings the whole stack up from a clean checkout with two commands, and a developer with MIS credentials can click "Sign in with NGA MIS" and land inside the authenticated shell.

### Status at time of writing — 20 August 2026

| Check | Result |
|---|---|
| V1 typecheck (7 workspaces) | ✅ clean |
| V2 build (7 workspaces) | ✅ web bundle 78 kB gzipped (target < 250 kB) |
| V3 migrations on a clean database | ✅ 2 applied, idempotent on re-run, 3 monthly `messages` partitions created |
| V4 all four backends healthy | ✅ api · realtime · files · worker |
| V5 web serves and proxies | ✅ HTTP 200; `/api/sso/me` correctly 401 without a token |
| V6 socket auth | ✅ authenticated accepted, anonymous rejected |
| V7 Redis → BullMQ → worker | ✅ job enqueued and processed |
| V8 file round-trip | ✅ 3,264 bytes, SHA-256 matches, unauthenticated download 401, ticket reuse 409 |
| V9 SSO exchange vs mocked MIS | ✅ 8 cases: success, idempotent re-login, audit entry, missing code, MIS rejection, MIS unreachable, degraded `/users/me`, rate limit |
| V10 no local authentication | ✅ no credential columns in the database, no credential code, `/login` and `/register` return 404 |
| V11 protected routes | ✅ 401 for absent, forged, and dangling sessions; MIS token never leaked to the client |
| V12 port preflight | ✅ 5190–5194 verified free via netstat |
| Extra — `npm audit` | ✅ 0 vulnerabilities |
| Extra — UI renders | ✅ sign-in and authenticated shell screenshotted, 0 console errors |

**Total: 47 automated tests + 8 runtime acceptance checks + 14 end-to-end MIS↔Tupo checks, all passing.**

### Two-ended verification against the running MIS

Driven by `npm run e2e` against the real MIS on :5001 — the genuine chain
`MIS /sso/authorize` → code → `Tupo /api/sso/exchange` → `MIS /sso/token` → Tupo session:

| Check | Result |
|---|---|
| MIS issues an authorization code for `client_id=tupo` | ✅ |
| MIS rejects an unregistered `redirect_uri` | ✅ 400 |
| Tupo exchanges the code and issues its own session | ✅ |
| Tupo mirrors the MIS identity | ✅ |
| Tupo derives an RBAC role from MIS permissions | ✅ Admin |
| Tupo returns its own 60-permission set, not the MIS's 72 | ✅ |
| The MIS token is never exposed to the browser | ✅ |
| Permissions actually gate the API | ✅ |
| A replayed authorization code is rejected | ✅ 401 |
| Demotion takes effect on the next request, same token | ✅ 200 → 403 → 200 |
| MIS-session poll works | ✅ |
| App switcher lists MIS, TaskMentor, Tendo, Tupo | ✅ |

**Unblocked.** The client is registered locally and the live exchange is verified. For production, register the same client on the production MIS with the `https://tupo.amashuri.com/sso/callback` redirect URI and issue a fresh secret.
