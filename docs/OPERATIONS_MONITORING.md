# Tupo: Monitoring, Alerts and Rollback

For whoever runs Tupo on the shared NGA host. Covers what is watched, how to be told, and what to do when something breaks. Backups are in [`OPERATIONS_BACKUP.md`](OPERATIONS_BACKUP.md).

---

## 1. Where to look

**Admin › System** (`/app/system`, needs `SYSTEM_HEALTH_VIEW`) shows:

- **Services:** live health of api, realtime, files and worker, re-checked every 30 s.
- **Alerts:** which rules are firing now, with the reading that tripped them.
- **Last hour:** requests, 5xx errors, p95 latency, connected sockets, jobs waiting, event-loop lag, free memory and free disk.
- **Errors:** crashes from browsers and from every service, grouped by fingerprint. Open one to see the stack, then **Mark resolved** or **Ignore**. A resolved error that comes back reopens itself.

The data lives in Postgres (`metric_samples`, `error_events`, `alert_state`, migration `0043`). Samples are kept 14 days. Settled errors are kept 90 days.

## 2. Being told

The worker checks the rules every minute. It notifies when a rule starts firing, again every 6 hours while it lasts, and once more when it resolves.

Set these in `apps/worker/.env`, then `pm2 reload tupo-worker --update-env`:

| Variable | Meaning |
|---|---|
| `ALERT_EMAILS` | Comma-separated addresses. Sent through the school SMTP relay already configured for Mail. |
| `ALERT_TELEGRAM_BOT_TOKEN`, `ALERT_TELEGRAM_CHAT_ID` | Optional. The same bot the MIS reminder hub uses works. |

With neither set, alerts are only written to the worker log (`pm2 logs tupo-worker`).

### Rules and thresholds

Every threshold can be overridden in `apps/worker/.env`.

| Rule | Fires when | Override |
|---|---|---|
| `api_error_rate` | More than 5% of API requests are 5xx over 5 min (only with at least 50 requests) | `ALERT_ERROR_RATE_PCT` |
| `api_slow` | API p95 latency is over 1500 ms | `ALERT_P95_MS` |
| `event_loop_lag` | Any service's event-loop p95 is over 250 ms | `ALERT_EVENT_LOOP_MS` |
| `queue_backlog` | More than 500 jobs have been waiting for 5 min | `ALERT_QUEUE_DEPTH` |
| `low_memory` | Under 200 MB available on the host | `ALERT_FREE_MEM_MB` |
| `low_disk` | Under 10% free on `/` | `ALERT_DISK_FREE_PCT` |
| `partitions_running_out` | Fewer than 2 months of `messages` / `meeting_events` partitions prepared | — |
| `redis_memory` | Redis is using more than 512 MB | `ALERT_REDIS_MB` |
| `error_spike` | More than 25 open errors were recorded in 10 min | `ALERT_ERROR_SPIKE` |
| `api_silent`, `realtime_silent`, `files_silent` | A service has not reported for 3 minutes (it is down, or cannot reach Postgres) | — |

## 3. Redis

One Redis instance serves both the realtime pub/sub and presence (db 0) and BullMQ (db 1). The eviction policy applies to the whole instance, and BullMQ needs **`noeviction`**: an evicted job key is a lost job. Give Redis a ceiling, so a leak cannot take the box's memory from the other three apps, and let the `redis_memory` alert give warning before the ceiling is reached:

```
# /etc/redis/redis.conf
maxmemory 768mb
maxmemory-policy noeviction
```

Then run `sudo systemctl restart redis-server`. Presence and typing keys carry their own TTLs, so they do not accumulate.

## 4. Deploys and rollback

- **The API** runs as 2 pm2 cluster instances. `pm2 reload` replaces them one at a time, so deploys and crashes do not drop requests. This was measured at 0 errors in 11,629 requests across two reloads; a single fork-mode process dropped 840.
- **The gateway** runs as one process. On a restart it tells clients first. They reconnect over about 4 seconds and catch up from the API.
- **Each deploy snapshots** the running build first (`scripts/release.sh snapshot`, newest 3 kept in `~/tupo-releases`). It also keeps the previous web chunks, so tabs opened before the deploy still load theirs.

To roll back the code:

```bash
cd /opt/apps/nga-communication-module
bash scripts/release.sh list
bash scripts/release.sh rollback            # the newest snapshot, or: rollback <id>
npm run health
```

Rollback restores the built code only. Migrations are written to be backward-compatible for one release (expand, then contract), so the previous code still runs on the newer schema. If the snapshot's `package-lock.json` differs, the script prints the `npm ci` command to run.

## 5. Release id

The deploy exports `TUPO_RELEASE` (the commit, 8 characters). Error rows and the web bundle carry it, so the Errors list says which release a crash came from.
