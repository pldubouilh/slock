#!/usr/bin/env bash
# Boot slock against a scratch database, run scripts/smoke.py, tear it down.
#
#   scripts/e2e.sh                  # uses the local dev postgres on :5433
#   PGPORT=5432 scripts/e2e.sh      # or point it somewhere else
#
# Exits non-zero if the suite fails; the server log is printed on failure.
set -uo pipefail

cd "$(dirname "$0")/.."

PGHOST=${PGHOST:-127.0.0.1}
PGPORT=${PGPORT:-5433}
PGUSER=${PGUSER:-slock}
DBNAME=${DBNAME:-slock_e2e}
PORT=${PORT:-8099}
ADMIN_PW=${ADMIN_PW:-smoke-admin-pw-1}

WORK=$(mktemp -d)
LOG="$WORK/server.log"
PID=""

cleanup() {
  [ -n "$PID" ] && kill "$PID" 2>/dev/null
  [ -n "$PID" ] && wait "$PID" 2>/dev/null
  rm -rf "$WORK"
}
trap cleanup EXIT

if ! psql -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d postgres -tAc 'select 1' >/dev/null 2>&1; then
  echo "no postgres on $PGHOST:$PGPORT — start one with: scripts/testdb.sh up" >&2
  exit 1
fi

# WITH (FORCE) so a leftover connection from a previous run cannot block the drop.
psql -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d postgres -q \
  -c "DROP DATABASE IF EXISTS $DBNAME WITH (FORCE);" -c "CREATE DATABASE $DBNAME OWNER $PGUSER;" \
  2>&1 | grep -v '^NOTICE' >&2

# Build once and run the binary directly: `go run` forks the real process, so
# killing it would leave the server holding the port.
BIN="$WORK/slock"
go build -o "$BIN" ./cmd/slock || exit 1

# Push needs no setup: the server mints its keypair into the database on first
# boot, so the push path is exercised rather than skipped.
DATABASE_URL="postgres://$PGUSER@$PGHOST:$PGPORT/$DBNAME?sslmode=disable" \
ADDR="127.0.0.1:$PORT" \
DATA_DIR="$WORK/data" \
BASE_URL="http://127.0.0.1:$PORT" \
BOOTSTRAP_ADMIN_EMAIL=admin@localhost \
BOOTSTRAP_ADMIN_PASSWORD="$ADMIN_PW" \
SLOCK_WEB_DIR=${SLOCK_WEB_DIR-web/assets} \
  "$BIN" >"$LOG" 2>&1 &
PID=$!

for _ in $(seq 1 60); do
  curl -fsS -o /dev/null "http://127.0.0.1:$PORT/api/push/key" 2>/dev/null && break
  kill -0 "$PID" 2>/dev/null || break
  sleep 0.5
done

python3 scripts/smoke.py "http://127.0.0.1:$PORT" admin@localhost "$ADMIN_PW"
status=$?

if [ $status -ne 0 ]; then
  echo; echo "--- server log ---"; cat "$LOG"
else
  # A clean run must not have logged any handler faults.
  if grep -qE 'httpx:|panic:' "$LOG"; then
    echo; echo "--- server logged errors during a passing run ---"
    grep -nE 'httpx:|panic:' "$LOG"
    status=1
  fi
fi

exit $status
