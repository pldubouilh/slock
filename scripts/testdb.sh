#!/usr/bin/env bash
# A throwaway Postgres for developing and testing slock.
#
# It runs as your own user out of a data directory in $HOME — no root, no
# Docker, no system service, nothing to conflict with a "real" Postgres you may
# already have on 5432. Auth is `trust` and it only listens on 127.0.0.1, which
# is fine for a scratch database and is not fine for anything else.
#
#   scripts/testdb.sh up       # create the cluster if needed, start it, make the db
#   scripts/testdb.sh url      # print DATABASE_URL for the dev database
#   scripts/testdb.sh psql     # open a shell on it
#   scripts/testdb.sh reset    # drop and recreate the dev database (empty schema)
#   scripts/testdb.sh status   # is it running, and what is in it
#   scripts/testdb.sh down     # stop the server (keeps the data)
#   scripts/testdb.sh destroy  # stop and delete the data directory entirely
#
# Override with env vars: PGDATA_DIR, PGPORT, PGUSER, DBNAME.
set -uo pipefail

PGDATA_DIR=${PGDATA_DIR:-$HOME/.slock-testdb}
PGPORT=${PGPORT:-5433}
PGUSER=${PGUSER:-slock}
DBNAME=${DBNAME:-slock_dev}
PGHOST=127.0.0.1

LOG="$PGDATA_DIR/server.log"
URL="postgres://$PGUSER@$PGHOST:$PGPORT/$DBNAME?sslmode=disable"

die() { echo "error: $*" >&2; exit 1; }

need_binaries() {
  command -v initdb >/dev/null || die "postgres is not installed (need initdb/pg_ctl/psql on PATH)"
}

running() {
  pg_ctl -D "$PGDATA_DIR" status >/dev/null 2>&1
}

wait_ready() {
  for _ in $(seq 1 40); do
    psql -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d postgres -tAc 'select 1' >/dev/null 2>&1 && return 0
    sleep 0.25
  done
  return 1
}

cmd_up() {
  need_binaries
  if [ ! -s "$PGDATA_DIR/PG_VERSION" ]; then
    echo "creating cluster in $PGDATA_DIR"
    initdb -D "$PGDATA_DIR" -U "$PGUSER" --auth=trust -E UTF8 >/dev/null || die "initdb failed"
  fi

  if running; then
    echo "already running on port $PGPORT"
  else
    pg_ctl -D "$PGDATA_DIR" -l "$LOG" \
      -o "-p $PGPORT -k /tmp -c listen_addresses=$PGHOST" start >/dev/null \
      || { tail -20 "$LOG" >&2; die "could not start postgres (see $LOG)"; }
    wait_ready || { tail -20 "$LOG" >&2; die "postgres did not become ready"; }
    echo "started on port $PGPORT"
  fi

  if ! psql -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d postgres -tAc \
      "select 1 from pg_database where datname='$DBNAME'" | grep -q 1; then
    psql -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d postgres -q \
      -c "CREATE DATABASE $DBNAME OWNER $PGUSER;" || die "could not create $DBNAME"
    echo "created database $DBNAME"
  fi

  echo
  echo "DATABASE_URL=$URL"
  echo
  echo "run slock against it with:  scripts/dev.sh"
}

cmd_down() {
  running || { echo "not running"; return 0; }
  pg_ctl -D "$PGDATA_DIR" -m fast stop >/dev/null && echo "stopped"
}

cmd_destroy() {
  cmd_down
  rm -rf "$PGDATA_DIR"
  echo "removed $PGDATA_DIR"
}

cmd_reset() {
  running || die "not running — try: scripts/testdb.sh up"
  psql -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d postgres -q \
    -c "DROP DATABASE IF EXISTS $DBNAME WITH (FORCE);" \
    -c "CREATE DATABASE $DBNAME OWNER $PGUSER;" || die "reset failed"
  echo "$DBNAME is empty; slock will recreate the schema and a fresh admin on next start"
}

cmd_url() { echo "$URL"; }

cmd_psql() {
  running || die "not running — try: scripts/testdb.sh up"
  exec psql -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d "$DBNAME"
}

cmd_status() {
  if running; then
    echo "running: $PGDATA_DIR (port $PGPORT)"
  else
    echo "stopped: $PGDATA_DIR"
    return 0
  fi
  echo
  psql -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d postgres -c \
    "select datname as database, pg_size_pretty(pg_database_size(datname)) as size
       from pg_database where not datistemplate order by datname;"
  psql -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d "$DBNAME" -c \
    "select (select count(*) from users) as users,
            (select count(*) from channels) as channels,
            (select count(*) from messages) as messages;" 2>/dev/null \
    || echo "($DBNAME has no slock schema yet — start the server once)"
}

case "${1:-up}" in
  up)      cmd_up ;;
  down)    cmd_down ;;
  destroy) cmd_destroy ;;
  reset)   cmd_reset ;;
  url)     cmd_url ;;
  psql)    cmd_psql ;;
  status)  cmd_status ;;
  *)       sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 1 ;;
esac
