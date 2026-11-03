#!/usr/bin/env bash
# One-time and self-healing host setup, run by every deploy after the build
# and migrations (see .github/workflows/deploy.yml). Each step checks first and
# does nothing when already done, so running it again is always safe.
#
#   - web push keys (VAPID) in the api and worker settings, if missing;
#   - monitoring alert recipients in the worker settings, if missing;
#   - a Redis memory ceiling with noeviction (BullMQ needs it);
#   - the mail HTML re-sanitising backfill, once;
#   - tupo-api moved from one fork process to the two-process cluster, once
#     (`pm2 reload` cannot change a process's mode).
#
# Nothing here prints a secret.
set -euo pipefail

ROOT="${TUPO_ROOT:-/opt/apps/nga-communication-module}"
STATE="${HOME}/.tupo"
cd "$ROOT"
mkdir -p "$STATE"

has() { grep -q "^$1=" "$2" 2>/dev/null; }

# ── Web push (F-04, N-01..N-04) ───────────────────────────────────────────
API_ENV="apps/api/.env"; WORKER_ENV="apps/worker/.env"
if ! has VAPID_PUBLIC_KEY "$API_ENV" || ! has VAPID_PUBLIC_KEY "$WORKER_ENV"; then
  if has VAPID_PUBLIC_KEY "$API_ENV"; then
    # Reuse the api's pair: both services must sign with the same keys.
    PUB="$(grep '^VAPID_PUBLIC_KEY=' "$API_ENV" | cut -d= -f2-)"
    PRIV="$(grep '^VAPID_PRIVATE_KEY=' "$API_ENV" | cut -d= -f2-)"
  else
    KEYS="$(cd packages/notify && node -e "const w=require('web-push');const k=w.generateVAPIDKeys();console.log(k.publicKey+' '+k.privateKey)")"
    PUB="${KEYS% *}"; PRIV="${KEYS#* }"
  fi
  for f in "$API_ENV" "$WORKER_ENV"; do
    if ! has VAPID_PUBLIC_KEY "$f"; then
      printf '\n# Web push (added by scripts/deploy-setup.sh)\nVAPID_PUBLIC_KEY=%s\nVAPID_PRIVATE_KEY=%s\nVAPID_SUBJECT=mailto:mis@nga.ac.rw\n' "$PUB" "$PRIV" >> "$f"
      echo "setup: web push keys added to $f"
    fi
  done
fi

# ── Monitoring alerts (R-04) ──────────────────────────────────────────────
if ! has ALERT_EMAILS "$WORKER_ENV"; then
  printf '\n# Monitoring alerts (added by scripts/deploy-setup.sh; see docs/OPERATIONS_MONITORING.md)\nALERT_EMAILS=%s\n' \
    "${TUPO_ALERT_EMAILS:-mis@nga.ac.rw}" >> "$WORKER_ENV"
  echo "setup: alert recipients added to $WORKER_ENV"
fi

# ── Redis ceiling (R-07) ──────────────────────────────────────────────────
if command -v redis-cli >/dev/null 2>&1; then
  if [ "$(redis-cli config get maxmemory | tail -n 1)" = "0" ]; then
    redis-cli config set maxmemory 768mb >/dev/null
    redis-cli config set maxmemory-policy noeviction >/dev/null
    # Persist to redis.conf when the server is allowed to; otherwise it holds
    # until Redis restarts and this script sets it again on the next deploy.
    redis-cli config rewrite >/dev/null 2>&1 && echo "setup: redis ceiling 768mb (persisted)" \
      || echo "setup: redis ceiling 768mb (until restart; config rewrite not permitted)"
  fi
fi

# ── Mail HTML backfill (C-02), once ───────────────────────────────────────
if [ ! -f "$STATE/mail-sanitized-v1" ]; then
  node scripts/mail-sanitize-backfill.mjs --apply && touch "$STATE/mail-sanitized-v1" \
    && echo "setup: mail HTML re-sanitised"
fi

# ── API in cluster mode (R-01), once ──────────────────────────────────────
MODE="$(pm2 jlist 2>/dev/null | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{const p=JSON.parse(d).find(x=>x.name==='tupo-api');console.log(p?p.pm2_env.exec_mode:'none')}catch{console.log('unknown')}})")"
if [ "$MODE" = "fork_mode" ]; then
  echo "setup: moving tupo-api to cluster mode (a few seconds of API restart, once)"
  pm2 delete tupo-api >/dev/null
  pm2 start ecosystem.config.cjs --only tupo-api --update-env >/dev/null
  pm2 save >/dev/null
fi

echo "setup: done"
