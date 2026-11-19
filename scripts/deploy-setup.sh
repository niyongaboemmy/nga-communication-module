#!/usr/bin/env bash
# One-time and self-healing host setup, run by every deploy after the build
# and migrations (see .github/workflows/deploy.yml). Each step checks first and
# does nothing when already done, so running it again is always safe.
#
#   - web push keys (VAPID) in the api and worker settings, if missing;
#   - monitoring alert recipients in the worker settings, if missing;
#   - shared secrets for email attachments and unsubscribe links, if missing;
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

# ── Email copies: attachments and unsubscribe links (M5) ─────────────────
FILES_ENV="apps/files/.env"
# One value shared by the listed files; generated once, then reused.
share_secret() {
  local key="$1"; shift
  local val=""
  for f in "$@"; do has "$key" "$f" && val="$(grep "^$key=" "$f" | tail -n 1 | cut -d= -f2-)" && break; done
  [ -n "$val" ] || val="$(openssl rand -hex 32)"
  for f in "$@"; do
    if ! has "$key" "$f"; then
      printf '\n# Added by scripts/deploy-setup.sh\n%s=%s\n' "$key" "$val" >> "$f"
      echo "setup: $key added to $f"
    fi
  done
}
share_secret FILES_INTERNAL_SECRET "$FILES_ENV" "$WORKER_ENV"
share_secret MAIL_LINK_SECRET "$API_ENV" "$WORKER_ENV"

# ── Receiving outside email (docs/MAIL_INBOUND_PLAN_2026-11.md) ──────────
# The key that encrypts connected mailboxes' passwords: the api stores them,
# the worker reads mailboxes with them, so both hold the same key.
share_secret MAIL_ACCOUNT_KEY "$API_ENV" "$WORKER_ENV"
# The mailbox server. NOT the relay: NGA's relay (mail.hackflix.net) is the
# incoming exchanger and refuses mailbox logins; the mailboxes (and webmail)
# live on the provider's server, mail.supremecenter.com (= imap/smtp.hackflix.net).
# Another school sets TUPO_MAILBOX_HOST. The relay stays as a fallback host,
# tried second (MAIL_IMAP_HOSTS). The first release copied the relay's host
# into MAIL_IMAP_HOST; that copy is corrected here, a hand-set value is not.
MAILBOX_HOST="${TUPO_MAILBOX_HOST:-mail.supremecenter.com}"
if has SMTP_HOST "$WORKER_ENV"; then
  RELAYHOST="$(grep '^SMTP_HOST=' "$WORKER_ENV" | tail -n 1 | cut -d= -f2- | tr -d '"'"'"' ')"
  for f in "$API_ENV" "$WORKER_ENV"; do
    CUR="$(grep '^MAIL_IMAP_HOST=' "$f" 2>/dev/null | tail -n 1 | cut -d= -f2- | tr -d '"'"'"' ')"
    if [ -z "$CUR" ]; then
      printf '\n# Added by scripts/deploy-setup.sh (connected mailboxes)\nMAIL_IMAP_HOST=%s\n' "$MAILBOX_HOST" >> "$f"
      echo "setup: MAIL_IMAP_HOST added to $f"
    elif [ "$CUR" = "$RELAYHOST" ] && [ "$CUR" != "$MAILBOX_HOST" ]; then
      sed -i "s|^MAIL_IMAP_HOST=.*|MAIL_IMAP_HOST=$MAILBOX_HOST|" "$f"
      echo "setup: MAIL_IMAP_HOST corrected to the mailbox server in $f"
    fi
    if [ -n "$RELAYHOST" ] && [ "$RELAYHOST" != "$MAILBOX_HOST" ] && ! has MAIL_IMAP_HOSTS "$f"; then
      printf '\n# Added by scripts/deploy-setup.sh (fallback mailbox host)\nMAIL_IMAP_HOSTS=%s\n' "$RELAYHOST" >> "$f"
      echo "setup: MAIL_IMAP_HOSTS added to $f"
    fi
  done
  if ! has MAIL_ACCOUNT_DOMAIN "$API_ENV" && has MAIL_FROM "$WORKER_ENV"; then
    DOMAIN="$(grep '^MAIL_FROM=' "$WORKER_ENV" | tail -n 1 | sed -E 's/.*@([A-Za-z0-9.-]+).*/\1/')"
    if [ -n "$DOMAIN" ]; then
      printf '\n# Added by scripts/deploy-setup.sh (connected mailboxes)\nMAIL_ACCOUNT_DOMAIN=%s\n' "$DOMAIN" >> "$API_ENV"
      echo "setup: MAIL_ACCOUNT_DOMAIN added to $API_ENV"
    fi
  fi
fi
# Shared reply capture (MAIL_REPLY_CAPTURE=on in BOTH files) is left to the
# school: it reads the relay's mailbox, which the MIS shares.
# The address people open Tupo at: links in emails (digests, unsubscribe)
# point there. Unset, they fell back to localhost. The first CORS origin is it.
if ! has APP_PUBLIC_URL "$API_ENV" && has CORS_ORIGINS "$API_ENV"; then
  ORIGIN="$(grep '^CORS_ORIGINS=' "$API_ENV" | tail -n 1 | cut -d= -f2- | cut -d, -f1 | tr -d '"'"'"' ')"
  if [ -n "$ORIGIN" ]; then
    printf '\n# Added by scripts/deploy-setup.sh (links in emails)\nAPP_PUBLIC_URL=%s\n' "$ORIGIN" >> "$API_ENV"
    echo "setup: APP_PUBLIC_URL added to $API_ENV"
  fi
fi
if ! has APP_PUBLIC_URL "$WORKER_ENV" && has APP_PUBLIC_URL "$API_ENV"; then
  printf '\n# Added by scripts/deploy-setup.sh (unsubscribe links)\n%s\n' "$(grep '^APP_PUBLIC_URL=' "$API_ENV" | tail -n 1)" >> "$WORKER_ENV"
  echo "setup: APP_PUBLIC_URL added to $WORKER_ENV"
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
