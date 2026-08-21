# slock

A small, fast, self-hosted team chat. 

- Go backend, Postgres, plain HTML/CSS/JS client. 
- Lightweight UI, no framework, weights less than 300KB, loads in milliseconds.
- Server has 1 dependency (postgres), everything else is standard library.
- Scales well over 100+ concurrent users on tiny 1vcpu host.
- Phone app support with notifications (PWA)
- Deliberately lean interface with markdown support, attachments, lightweight theming.
- Functional fuzzy search and channel switcher.
- Supports bot integration.
- An IRC inspired terminal client.

<img width="1452" height="879" alt="Image" src="https://github.com/user-attachments/assets/903f4230-a4aa-4dba-9cbf-9ba00b647c50" />

## Quick start

Start with docker compose to boot slock alongside potgres:

```sh
; cp slock.config.example slock.config
; docker compose up
# you can also docker compose up --build to build from source
```

Then open <http://localhost:8080>. On the very first boot slock creates an admin account and prints the password:

## Deploying it somewhere

You need a server with docker installed, a domain, and properly configured DNS. 

```sh
; git clone https://github.com/pldubouilh/slock.git /opt/slock
; cd /opt/slock
; cp slock.config.example slock.config
```

Edit `slock.config` to set `BASE_URL` to the https domain it will be deployed on. Every other setting has a sensible default, see the comments in `slock.config.example` for the full list.

You can now start slock: 

```sh
; docker compose up -d
```

slock binds to `127.0.0.1:8080`. Front it with [caddy](https://caddyserver.com/) (or your other) to get https and reverse proxy. Example caddy config: 

```
slock.example.com {
    reverse_proxy 127.0.0.1:8080
}
```
