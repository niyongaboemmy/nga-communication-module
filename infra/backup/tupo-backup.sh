#!/usr/bin/env bash
# Nightly backup for Tupo (G-02): the PostgreSQL database and the uploads.
#
#   TUPO_DB_URL=postgres://tupo:...@localhost:5432/tupo_prod \
#   TUPO_STORAGE=/var/lib/tupo/storage \
#   TUPO_BACKUP_DIR=/var/backups/tupo \
#   [TUPO_BACKUP_REMOTE=user@host:/backups/tupo]   # optional off-box copy
#   [TUPO_BACKUP_KEEP_DAYS=14] \
#   [TUPO_PG_BIN=/usr/lib/postgresql/18/bin]      # pg_dump matching the server
#   infra/backup/tupo-backup.sh
#
# Writes <dir>/db/tupo-YYYYmmdd-HHMM.dump (pg_dump custom format, restorable
# with pg_restore) and mirrors uploads into <dir>/storage/ with hard-linked
# daily snapshots, prunes anything older than KEEP_DAYS, and — if REMOTE is
# set — rsyncs the lot off the box. Exits non-zero on any failure so cron
# mail / monitoring notices. Restore drill: docs/OPERATIONS_BACKUP.md.
set -euo pipefail

: "${TUPO_DB_URL:?set TUPO_DB_URL}"
: "${TUPO_STORAGE:?set TUPO_STORAGE}"
: "${TUPO_BACKUP_DIR:?set TUPO_BACKUP_DIR}"
KEEP_DAYS="${TUPO_BACKUP_KEEP_DAYS:-14}"
# pg_dump refuses a server newer than itself; point at the matching client.
if [ -n "${TUPO_PG_BIN:-}" ]; then export PATH="$TUPO_PG_BIN:$PATH"; fi
STAMP="$(date +%Y%m%d-%H%M)"
DAY="$(date +%Y%m%d)"

mkdir -p "$TUPO_BACKUP_DIR/db" "$TUPO_BACKUP_DIR/storage"

# 1. Database — custom format: compressed, and restorable table by table.
DUMP="$TUPO_BACKUP_DIR/db/tupo-$STAMP.dump"
pg_dump --format=custom --no-owner --no-privileges --file="$DUMP.partial" "$TUPO_DB_URL"
mv "$DUMP.partial" "$DUMP"
# A dump that pg_restore cannot list is not a backup.
pg_restore --list "$DUMP" > /dev/null

# 2. Uploads — a daily snapshot, hard-linked against yesterday's so an
#    unchanged file costs no extra space.
LATEST="$TUPO_BACKUP_DIR/storage/latest"
SNAP="$TUPO_BACKUP_DIR/storage/$DAY"
if [ -d "$LATEST" ]; then
  rsync -a --delete --link-dest="$LATEST" "$TUPO_STORAGE/" "$SNAP/"
else
  rsync -a --delete "$TUPO_STORAGE/" "$SNAP/"
fi
ln -sfn "$SNAP" "$LATEST"

# 3. Retention.
find "$TUPO_BACKUP_DIR/db" -name 'tupo-*.dump' -mtime +"$KEEP_DAYS" -delete
find "$TUPO_BACKUP_DIR/storage" -mindepth 1 -maxdepth 1 -type d -name '20*' -mtime +"$KEEP_DAYS" -exec rm -rf {} +

# 4. Off the box, if configured — a backup on the same disk as the data is
#    not a backup against losing that disk.
if [ -n "${TUPO_BACKUP_REMOTE:-}" ]; then
  rsync -a --delete "$TUPO_BACKUP_DIR/" "$TUPO_BACKUP_REMOTE/"
fi

echo "[tupo-backup] ok: $DUMP ($(du -h "$DUMP" | cut -f1)), uploads snapshot $SNAP"
