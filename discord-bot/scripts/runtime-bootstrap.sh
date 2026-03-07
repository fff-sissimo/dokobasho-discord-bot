#!/bin/sh
set -eu

if [ "$#" -lt 1 ]; then
  echo "usage: runtime-bootstrap.sh <node-entry> [args...]" >&2
  exit 64
fi

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
APP_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
LOCK_DIR="${RUNTIME_INSTALL_LOCK_DIR:-$APP_DIR/.runtime-install.lock}"
STAMP_FILE="${RUNTIME_INSTALL_STAMP_FILE:-$APP_DIR/.runtime-install.stamp}"

cleanup() {
  rmdir "$LOCK_DIR" 2>/dev/null || true
}

while ! mkdir "$LOCK_DIR" 2>/dev/null; do
  sleep 1
done
trap cleanup EXIT INT TERM

cd "$APP_DIR"

CURRENT_STAMP=$(cat package-lock.json package.json | sha256sum | awk '{print $1}')
INSTALLED_STAMP=""
if [ -f "$STAMP_FILE" ]; then
  INSTALLED_STAMP=$(cat "$STAMP_FILE" 2>/dev/null || true)
fi

if [ ! -d node_modules ] || [ "$CURRENT_STAMP" != "$INSTALLED_STAMP" ]; then
  rm -rf node_modules
  npm ci --omit=dev
  printf '%s\n' "$CURRENT_STAMP" > "$STAMP_FILE"
fi

trap - EXIT INT TERM
cleanup

exec node "$@"
