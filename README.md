# slock

A small, fuss-free, fast, self-hosted team chat. 

- Go backend, Postgres, plain HTML/CSS/JS client. 
- Lightweight UI with no framework (<300KiB, loads in ms), with lightweight theming support.
- 1 dependency (server postgres), everything else is standard library.
- Scales well over 100+ concurrent users on tiny 1vcpu host.
- Phone app support with notifications (PWA).
- Message support markdown & attachments.
- Fuzzy search / channel switcher.
- Support for bot integration.
- IRC inspired terminal client.

<img width="1452" height="879" alt="Image" src="https://github.com/user-attachments/assets/903f4230-a4aa-4dba-9cbf-9ba00b647c50" />

## Quick start 

Start with docker compose to boot slock alongside potgres:

```sh
; cp slock.config.example slock.config
; docker compose up
# you can also docker compose up --build to build from source
```

Then open <http://localhost:8080>. On the very first boot slock creates an admin account and prints the password.

## Deploying it somewhere

You need a server with docker installed, a domain, and properly configured DNS. 

```sh
; git clone https://github.com/pldubouilh/slock.git /opt/slock
; cd /opt/slock
; cp slock.config.example slock.config
```

Edit `slock.config` to set `BASE_URL` to the https domain it will be deployed on. Every other setting has a sensible default, see the options on the default config for the full list.

You can now start slock: 

```sh
; docker compose up -d
```

slock binds to `127.0.0.1:8080`. Front it with [caddy](https://caddyserver.com/) (or your preferred webserver) to get https and reverse proxy. Example caddy config: 

```
slock.example.com {
    reverse_proxy 127.0.0.1:8080
}
```

## Monitoring

A quick health snapshot straight from Postgres — message and channel counts, and the size of the database on disk:

```sh
; docker compose exec -T db psql -U slock -d slock -c "
  SELECT (SELECT count(*) FROM messages)                    AS messages,
         (SELECT count(*) FROM channels)                    AS channels,
         (SELECT count(*) FROM users WHERE is_active)       AS users,
         pg_size_pretty(pg_database_size('slock'))          AS db_size"
```

Note that uploaded files live outside the database, in the `attachments` docker volume; `docker system df -v` shows its size.

## Backup & restore

slock's entire state is two things: the Postgres database and the attachments volume. 

```sh
; docker compose exec -T db pg_dump -U slock -Fc slock > slock-$(date +%F).dump
; docker compose exec -T slock tar cz -C /data . > attachments-$(date +%F).tgz
```

Both commands are safe to run on a live instance (`pg_dump` takes a consistent snapshot). Restore onto a fresh or existing instance — stop the app first so nothing writes during the restore, and note that the restore *replaces* what is in the database:

```sh
; docker compose stop slock
; docker compose exec -T db pg_restore -U slock -d slock --clean --if-exists < slock-2026-09-06.dump
; docker compose up -d
; docker compose exec -T slock tar xz -C /data < attachments-2026-09-06.tgz
```
