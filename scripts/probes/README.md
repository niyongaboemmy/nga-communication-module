# Gap-analysis probes

One-off scripts from the 2026-10-12 gap analysis. The ones that became
regression gates were promoted to named suites (G-03):

| Probe | Now |
| --- | --- |
| `gap-security-probe` | `npm run verify:security` |
| `gap-realtime-probe` | `npm run verify:realtime:journeys` |
| `gap-ui-probe` | `npm run verify:ui:journeys` |
| `gap2-unread-probe` | superseded by `verify:chat:unread` |
| `gap2-chat-journeys` | superseded by `verify:chat:links`, `verify:chat:liveness`, `verify:chat:safety` |
| `gap2-chat-cleanup` | superseded by `verify:purge` |
| `gap-xss-probe` | superseded by `apps/api/src/__tests__/mailSecurity.test.ts` |

Still open — these print `GAP`/`FAIL` for defects the Phase 2 work fixes, and
are promoted once they run clean:

- `gap2-mail-feed` — mail and feed journeys (Phase 2)
- `gap2-shell-probe` — app shell, global search, route guards, PWA (Phase 2)
- `gap2-dock-check` — chat dock layout spot-check

Run any of them with `node scripts/probes/<name>.mjs` against `npm run dev`.
