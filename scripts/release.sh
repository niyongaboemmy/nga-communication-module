#!/usr/bin/env bash
# Release snapshots and one-command rollback (R-06). Runs on the host.
#
#   scripts/release.sh snapshot       before a build: copy every built dist/ aside
#   scripts/release.sh keep-assets    after a build: carry the previous web chunks over
#   scripts/release.sh rollback [id]  put a snapshot's builds back and reload pm2
#   scripts/release.sh list           the snapshots on this host
#
# What a snapshot holds: apps/*/dist, packages/*/dist and the web bundle — what
# pm2 and nginx actually serve. Not node_modules (a rollback across a dependency
# change needs `npm ci` from that release's lock file, which is printed) and not
# the database: migrations are expand-only for one release, so the previous
# code still runs on the newer schema.
set -euo pipefail

ROOT="${TUPO_ROOT:-/opt/apps/nga-communication-module}"
# In the deploy user's home: /opt/apps belongs to another account on this host.
STORE="${TUPO_RELEASES:-$HOME/tupo-releases}"
KEEP="${TUPO_RELEASES_KEEP:-3}"
# Both paths are used with rm below: refuse anything that is not a real, absolute path.
case "$ROOT" in /?*) ;; *) echo "release: TUPO_ROOT must be absolute" >&2; exit 2 ;; esac
case "$STORE" in /?*/?*) ;; *) echo "release: TUPO_RELEASES must be an absolute path two levels deep" >&2; exit 2 ;; esac
cd "$ROOT"

dists() {
  for d in apps/*/dist packages/*/dist; do [ -d "$d" ] && echo "$d"; done
}

case "${1:-}" in
  snapshot)
    [ -n "$(dists)" ] || { echo "release: nothing built yet, no snapshot"; exit 0; }
    id="$(date -u +%Y%m%dT%H%M%SZ)"
    mkdir -p "$STORE/$id"
    # shellcheck disable=SC2046
    tar -czf "$STORE/$id/dist.tgz" $(dists)
    cp package-lock.json "$STORE/$id/" 2>/dev/null || true
    git rev-parse HEAD > "$STORE/$id/commit" 2>/dev/null || echo unknown > "$STORE/$id/commit"
    echo "release: snapshot $id ($(du -sh "$STORE/$id" | cut -f1))"
    # Portable (GNU and BSD): newest first, drop everything after $KEEP.
    for old in $(ls -1 "$STORE" | sort -r | tail -n +"$((KEEP + 1))"); do
      case "$old" in [0-9]*T*Z) rm -r -- "${STORE:?}/$old" ;; esac
    done
    ;;

  keep-assets)
    # Tabs opened before this deploy ask for the chunks their index.html named.
    # Keep the previous release's hashed files beside the new ones so those
    # tabs keep working until they reload (P-01). Never overwrite a new file.
    latest="$(ls -1d "$STORE"/*/ 2>/dev/null | sort | tail -n 1 || true)"
    [ -n "$latest" ] || { echo "release: no previous release to carry assets from"; exit 0; }
    tmp="$(mktemp -d)"
    tar -xzf "$latest/dist.tgz" -C "$tmp" apps/web/dist/assets 2>/dev/null || true
    if [ -d "$tmp/apps/web/dist/assets" ]; then
      n="$(ls "$tmp/apps/web/dist/assets" | wc -l)"
      cp -n "$tmp/apps/web/dist/assets/"* apps/web/dist/assets/ 2>/dev/null || true
      echo "release: carried $n previous web assets over (existing files kept)"
    fi
    rm -r -- "${tmp:?}"
    ;;

  rollback)
    id="${2:-$(ls -1 "$STORE" 2>/dev/null | sort | tail -n 1)}"
    [ -n "$id" ] && [ -f "$STORE/$id/dist.tgz" ] || { echo "release: no snapshot ${2:-found}"; exit 1; }
    echo "release: rolling back to $id (commit $(cat "$STORE/$id/commit"))"
    for d in $(dists); do rm -r -- "${ROOT:?}/$d"; done
    tar -xzf "$STORE/$id/dist.tgz"
    if ! cmp -s package-lock.json "$STORE/$id/package-lock.json"; then
      echo "release: WARNING dependencies changed since $id. If a service fails to start, run:"
      echo "         cp $STORE/$id/package-lock.json package-lock.json && npm ci && pm2 reload ecosystem.config.cjs"
    fi
    pm2 reload ecosystem.config.cjs --update-env
    pm2 save
    echo "release: rolled back. Run 'npm run health' to confirm."
    ;;

  list)
    for d in $(ls -1 "$STORE" 2>/dev/null | sort); do
      echo "$d  commit $(cat "$STORE/$d/commit" 2>/dev/null | cut -c1-8)  $(du -sh "$STORE/$d" | cut -f1)"
    done
    ;;

  *)
    sed -n '2,12p' "$0"; exit 2 ;;
esac
