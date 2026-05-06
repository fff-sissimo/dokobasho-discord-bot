#!/bin/sh
set -eu

entrypoint="${1:-index.js}"

case "$entrypoint" in
  index.js|scheduler.js|deploy-commands.js)
    ;;
  *)
    echo "[runtime-bootstrap] unsupported entrypoint: $entrypoint" >&2
    exit 64
    ;;
esac

if [ ! -f package.json ] || [ ! -f package-lock.json ]; then
  echo "[runtime-bootstrap] package.json and package-lock.json are required" >&2
  exit 66
fi

install_marker="node_modules/.package-lock.json"
needs_install() {
  [ ! -d node_modules ] || [ ! -f "$install_marker" ] || [ package-lock.json -nt "$install_marker" ]
}

if needs_install; then
  if [ -z "${NODE_AUTH_TOKEN:-}" ]; then
    echo "[runtime-bootstrap] NODE_AUTH_TOKEN is required to install @fff-sissimo/fairy-core" >&2
    exit 78
  fi
  install_lock_dir="../.discord-bot-npm-ci.lock"
  install_lock_created_at="$install_lock_dir/created_at"
  install_lock_stale_seconds="${RUNTIME_BOOTSTRAP_INSTALL_LOCK_STALE_SECONDS:-1800}"
  case "$install_lock_stale_seconds" in
    ''|*[!0-9]*)
      install_lock_stale_seconds=1800
      ;;
  esac
  if [ "$install_lock_stale_seconds" -lt 60 ]; then
    install_lock_stale_seconds=60
  fi
  current_epoch() {
    date +%s 2>/dev/null || echo 0
  }
  lock_is_stale() {
    now="$(current_epoch)"
    [ "$now" -gt 0 ] || return 1
    created_at="$(cat "$install_lock_created_at" 2>/dev/null || echo 0)"
    case "$created_at" in
      ''|*[!0-9]*)
        created_at=0
        ;;
    esac
    [ "$created_at" -gt 0 ] || return 1
    age=$((now - created_at))
    [ "$age" -ge "$install_lock_stale_seconds" ]
  }
  echo "[runtime-bootstrap] waiting for dependency install lock"
  while ! mkdir "$install_lock_dir" 2>/dev/null; do
    if lock_is_stale; then
      echo "[runtime-bootstrap] removing stale dependency install lock" >&2
      rm -rf "$install_lock_dir"
      continue
    fi
    sleep 2
  done
  current_epoch > "$install_lock_created_at"
  cleanup_install_lock() {
    rm -f "$install_lock_created_at" 2>/dev/null || true
    rmdir "$install_lock_dir" 2>/dev/null || true
  }
  on_interrupt() {
    cleanup_install_lock
    exit 130
  }
  on_terminate() {
    cleanup_install_lock
    exit 143
  }
  trap cleanup_install_lock EXIT
  trap on_interrupt INT
  trap on_terminate TERM
  if needs_install; then
    echo "[runtime-bootstrap] installing production dependencies"
    npm ci --omit=dev
  else
    echo "[runtime-bootstrap] production dependencies were installed by another service"
  fi
  cleanup_install_lock
  trap - EXIT INT TERM
else
  echo "[runtime-bootstrap] using existing production dependencies"
fi

exec node "$entrypoint"
