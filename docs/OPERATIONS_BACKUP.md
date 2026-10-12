# Tupo backups and restore

Covers the PostgreSQL database (`tupo_prod`) and the uploads directory
(`/var/lib/tupo/storage`). Script: [`infra/backup/tupo-backup.sh`](../infra/backup/tupo-backup.sh).

## Install on the EC2 host (once)

```bash
sudo mkdir -p /var/backups/tupo && sudo chown ubuntu: /var/backups/tupo
crontab -e
```

Add (02:30 every night; the DB URL is the API's own, from `apps/api/.env`):

```cron
30 2 * * * TUPO_DB_URL="$(grep ^DATABASE_URL= /opt/apps/nga-communication-module/apps/api/.env | cut -d= -f2-)" TUPO_STORAGE=/var/lib/tupo/storage TUPO_BACKUP_DIR=/var/backups/tupo TUPO_PG_BIN=/usr/lib/postgresql/18/bin /opt/apps/nga-communication-module/infra/backup/tupo-backup.sh >> /var/log/tupo-backup.log 2>&1
```

Set `TUPO_BACKUP_REMOTE=user@host:/path` as well to copy everything off the box. A backup on the same disk does not protect against losing that disk.

## What it does

1. Runs `pg_dump --format=custom` into `db/tupo-YYYYmmdd-HHMM.dump`, then checks that `pg_restore --list` can read it.
2. Takes a daily uploads snapshot under `storage/YYYYmmdd/`. It is hard-linked against the previous one, so unchanged files cost nothing.
3. Deletes dumps and snapshots older than `TUPO_BACKUP_KEEP_DAYS` (default 14).
4. Optionally rsyncs everything to `TUPO_BACKUP_REMOTE`.
5. Exits non-zero on any failure.

## Restore drill

Run it once after installing, then every term.

```bash
B=/usr/lib/postgresql/18/bin
createdb tupo_restore_drill
$B/pg_restore --no-owner --dbname=postgres:///tupo_restore_drill /var/backups/tupo/db/<latest>.dump
psql tupo_restore_drill -Atc "SELECT count(*) FROM users; SELECT tupo_partitions_ahead();"
dropdb tupo_restore_drill
```

To restore for real:

1. Stop the services: `pm2 stop tupo-api tupo-realtime tupo-files tupo-worker`.
2. Restore the database into `tupo_prod` (or a new database, then point `DATABASE_URL` at it).
3. Restore the uploads: `rsync -a /var/backups/tupo/storage/<day>/ /var/lib/tupo/storage/`.
4. Start the services and run `npm run health`.

Verified locally on 13 Oct 2026. Users (50/50) and messages (4553/4553) matched after restore, and the partition maintenance functions came back intact.
