# Tupo

Unified communication platform for the NGA ecosystem — chat, meetings, files, mail and an institutional feed.

Part of the NGA Digital Ecosystem alongside **NGA Central MIS**, **TaskMentor** and **Discipline & Attendance**.

- [Software Requirements Specification](docs/TUPO_SRS.md)
- [Phase 0 implementation plan](docs/IMPLEMENTATION_PLAN.md)

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
provides both, plus the MinIO/Meilisearch/LiveKit dependencies later phases need.)

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

## Roles & permissions

Authorization is Tupo's own, modelled on `nga-discipline-attendance`: **58 permissions across 12
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
