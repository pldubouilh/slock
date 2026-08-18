#!/usr/bin/env bash
# Start slock for local development: brings the scratch Postgres up if it is
# not already, then runs the server with the client served from disk so editing
# web/assets only needs a browser reload.
#
#   scripts/dev.sh              # http://localhost:8080
#   scripts/dev.sh --fresh      # throw the database away first
#   PORT=9000 scripts/dev.sh    # somewhere else
#
# There is no migration story yet: if internal/db/schema.sql changed, use
# --fresh. Booting against a database made by an older schema will not update
# it, and you will get missing-column errors.
#
# Anything you export yourself wins, so you can layer on extras:
#   SENDGRID_API_KEY=... scripts/dev.sh
set -uo pipefail

cd "$(dirname "$0")/.."

PORT=${PORT:-8080}
FRESH=""
for arg in "$@"; do
  case "$arg" in
    --fresh|-f) FRESH=1 ;;
    *) echo "unknown option: $arg" >&2; exit 1 ;;
  esac
done

# Bring the database up (idempotent) and take its URL, unless one is already set.
if [ -z "${DATABASE_URL:-}" ]; then
  ./scripts/testdb.sh up >/dev/null || exit 1
  if [ -n "$FRESH" ]; then
    ./scripts/testdb.sh reset >/dev/null || exit 1
    rm -rf "${DATA_DIR:-./data}"
    echo "database and uploads wiped"
  fi
  DATABASE_URL="$(./scripts/testdb.sh url)"
elif [ -n "$FRESH" ]; then
  echo "--fresh ignored: DATABASE_URL is set, so this script does not own the database" >&2
fi
export DATABASE_URL

export ADDR="${ADDR:-127.0.0.1:$PORT}"
export BASE_URL="${BASE_URL:-http://localhost:$PORT}"
export DATA_DIR="${DATA_DIR:-./data}"
export SLOCK_WEB_DIR="${SLOCK_WEB_DIR:-web/assets}"
export BOOTSTRAP_ADMIN_EMAIL="${BOOTSTRAP_ADMIN_EMAIL:-you@example.com}"
export BOOTSTRAP_ADMIN_PASSWORD="${BOOTSTRAP_ADMIN_PASSWORD:-devpassword1}"

# Web push keys generate themselves on first boot and are stored here, kept out
# of the repo's own slock.config so a dev run never touches your deploy config.
# Delete the file to mint a fresh pair.
export SLOCK_CONFIG="${SLOCK_CONFIG:-.dev-vapid}"
export VAPID_SUBJECT="${VAPID_SUBJECT:-mailto:dev@localhost}"

echo "slock dev"
echo "  url:      $BASE_URL"
echo "  database: $DATABASE_URL"
echo "  sign in:  $BOOTSTRAP_ADMIN_EMAIL / $BOOTSTRAP_ADMIN_PASSWORD (first run only)"
echo "  assets:   $SLOCK_WEB_DIR (edit and reload, no rebuild)"
echo
echo "  forgot the admin password?  scripts/testdb.sh reset  then restart"
echo

exec go run ./cmd/slock
