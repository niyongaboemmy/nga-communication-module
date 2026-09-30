# Meeting reminders (MIS Reminder Hub)

Tupo does not send "your meeting starts soon" itself. Every scheduled meeting
is described to the NGA MIS Reminder Hub, which reminds people through their
own MIS preferences: Web Push, in-app, and the calendar feed.

## Where it lives

- `packages/notify/src/reminders.ts` — builds items, talks to the Source API,
  runs the sweep. Shared by the API and the worker (`import { reminders } from '@tupo/notify'`).
- `apps/api/src/routes/meet.ts` — fire-and-forget `queueMeetingReminderSync` /
  `queueMeetingReminderCancel` after schedule, `PATCH` (reschedule, rename,
  status), `PUT /:id/name`, `POST /:id/invites`, `PUT /:id/invites/me`,
  `DELETE /:id` (cancel and purge) and `POST /:id/end`. A MIS failure is logged
  and never fails the request.
- `apps/worker/src/jobs/reminders.ts` — `reminders:sync`, every 30 minutes and
  once a minute after boot: re-sends every `scheduled` meeting starting in the
  next 14 days (`PUT /reminders/sources/batch`, 200 per request) and withdraws
  meetings cancelled or ended in the last day whose start is still ahead.
- Tests: `apps/api/src/__tests__/reminders.test.ts` (transport mocked, real DB).

## The item

| field | value |
|---|---|
| `source_app` / `source_type` | `tupo` / `meeting` |
| `external_id` | `meeting-<meeting id>` (stable; re-sending replaces) |
| `starts_at` / `ends_at` | `scheduled_start` / `scheduled_end` as UTC ISO; `ends_at` null if absent |
| `link` | `<APP_PUBLIC_URL>/app/meet/<join code>` (the same route as the ICS and MIS Home) |
| `audience_user_ids` | MIS ids (`users.mis_user_id`, never Tupo ids) of the host, every invitee who has not declined, and — for a meeting scheduled from a conversation — its current members. Active accounts only; guests have no account and are never included. Max 5000. |

Not sent: instant meetings (born live), meetings already live, meetings whose
start has passed, meetings with no `scheduled_start`. Cancelled / ended /
deleted meetings, and one left with nobody to remind, are withdrawn with
`DELETE /reminders/sources/tupo/meeting/<external_id>` (404 is fine).

Recurring meetings: only the stored `scheduled_start` is sent; the RRULE is
not expanded.

## Configuration

Authenticates as HTTP Basic with `SSO_CLIENT_ID:SSO_CLIENT_SECRET` against
`NGA_MIS_BASE_URL` — the same client Tupo uses for the SSO exchange.

| variable | meaning |
|---|---|
| `REMINDERS_SYNC` | `false` switches it off (API and worker) |
| `APP_PUBLIC_URL` | public web origin for the link; defaults to the first `CORS_ORIGINS` entry |
| `REMINDERS_API_ENV_PATH` | worker only: where to borrow the keys above from (default `../api/.env`) |

Always off under `NODE_ENV=test` and when the client secret is missing or the
`placeholder_client_secret` default. The worker reads `NGA_MIS_BASE_URL`,
`SSO_CLIENT_ID`, `SSO_CLIENT_SECRET`, `APP_PUBLIC_URL` and `CORS_ORIGINS` from
`apps/api/.env` when its own environment lacks them, and logs which it borrowed.
