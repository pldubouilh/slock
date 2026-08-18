# slock API contract

Single source of truth for the server and the client. If you need to change
something here, change it here first.

- All request and response bodies are JSON unless stated otherwise.
- Auth is a cookie: `slock_session`, `HttpOnly`, `SameSite=Lax`, `Path=/`.
- Errors: non-2xx with `{"error": "<code>", "message": "<human text>"}`.
  Codes: `unauthorized`, `forbidden`, `not_found`, `bad_request`, `conflict`,
  `too_large`, `invalid_credentials`, `account_disabled`, `internal`.
- IDs are JSON numbers (int64). Timestamps are RFC3339 strings.

## Object shapes

```jsonc
// User — `email` present only in /api/auth/me and admin endpoints.
// `avatar_url` is "" when the user has no picture; render initials on
// `avatar_color` instead. The URL carries a content hash, so it changes on
// every upload and may be cached forever.
{ "id": 3, "email": "ana@x.com", "display_name": "Ana", "avatar_color": 4,
  "status_text": "", "is_admin": false, "is_active": true,
  "created_at": "...", "last_seen_at": "...",
  "avatar_url": "/api/users/3/avatar?v=1a2b3c4d5e6f" }

// Channel — `kind` is "channel" or "dm".
{ "id": 12, "kind": "channel", "name": "design", "topic": "pixels",
  "is_private": false, "created_by": 1, "created_at": "...",
  "last_message_at": "...", "is_member": true, "muted": false,
  "unread_count": 3, "member_count": 8,   // unread_count saturates at 100
  "peer_user_id": 7,       // DMs only
  "members": [1,2,7] }     // only on GET /api/channels/{id}

// Message
{ "id": 901, "channel_id": 12, "user_id": 3, "body": "hi",
  "created_at": "...", "edited_at": null, "deleted_at": null,
  "attachments": [Attachment], "reactions": [Reaction],
  "client_id": "c-17" }    // echoed from the send request, for optimistic UI

// Attachment
{ "id": 55, "message_id": 901, "uploader_id": 3, "filename": "shot.png",
  "mime": "image/png", "size_bytes": 91234, "is_image": true,
  "width": 1920, "height": 1080, "has_display": true, "has_thumb": true }

// Reaction (aggregated per emoji)
{ "emoji": "👍", "count": 2, "user_ids": [1,3], "mine": true }
```

Attachment URLs are built client-side:
`/api/files/{attachment_id}/{variant}/{urlencoded filename}` where variant is
`original`, `display`, or `thumb`. Non-images only have `original`.

## Auth

| Method | Path | Body | Response |
|---|---|---|---|
| POST | `/api/auth/login` | `{email, password}` | `200 {user, must_change_pw}` + sets cookie |
| POST | `/api/auth/logout` | – | `204` |
| GET | `/api/auth/me` | – | `200 {user, must_change_pw, push_public_key}` |
| POST | `/api/auth/password` | `{current_password, new_password}` | `204` |
| POST | `/api/auth/forgot` | `{email}` | `204` always (no account enumeration) |
| POST | `/api/auth/reset` | `{token, new_password}` | `204` |

Login failures return `401 invalid_credentials`. Deactivated users get
`403 account_disabled`. Passwords must be at least 8 characters.

## Version

`GET /api/version` → `200 {version: "2026-08-14-9f3c1ab"}` — **no auth**.

The build id is the commit date and short hash, so two builds of the same
commit report the same string. A working tree with uncommitted changes gets a
`-dirty` suffix. The same value rides on the SSE `hello` frame, which is how a
client notices it reconnected to a newer build and reloads itself.

## Workspace identity

| Method | Path | Body | Response |
|---|---|---|---|
| GET | `/api/workspace` | – | `200 {workspace: {name, icon_url}}` — **no auth** |
| GET | `/api/workspace/icon` | – | image bytes, or `404` when unset — **no auth** |
| PATCH | `/api/admin/workspace` | `{name}` | `200 {workspace}` |
| POST | `/api/admin/workspace/icon` | multipart, field `file` | `200 {workspace}` |
| DELETE | `/api/admin/workspace/icon` | – | `200 {workspace}` |

The name and the mark beside it are admin-editable. `GET` is unauthenticated so
the sign-in page can brand itself. Name is 1–40 characters, defaulting to
`slock`. The icon takes the same image types as an avatar, 4 MB max, and
`icon_url` is `""` when unset — clients fall back to the built-in SVG mark.
Writes broadcast `workspace.update`.

## Users

| Method | Path | Body | Response |
|---|---|---|---|
| GET | `/api/users` | – | `200 {users: [User]}` — all active users |
| PATCH | `/api/users/me` | `{display_name?, avatar_color?, status_text?}` | `200 {user}` |
| POST | `/api/users/me/avatar` | multipart, field `file` | `200 {user}` |
| DELETE | `/api/users/me/avatar` | – | `200 {user}` |
| GET | `/api/users/{id}/avatar` | – | image bytes, or `404` if unset |

Profile pictures: JPEG/PNG/GIF/WebP only, 8 MB max, recompressed and downscaled
to 480px on the long edge on upload. Anything else is `400`, oversize is `413`.
Uploading replaces the previous picture; `DELETE` reverts to initials. Both
write endpoints broadcast `user.update` so other clients re-render immediately.
`GET` is readable by any signed-in user and is served `immutable`, which is safe
because the URL is versioned by content hash.

## Channels & DMs

| Method | Path | Body | Response |
|---|---|---|---|
| GET | `/api/channels` | – | `200 {channels: [Channel], dms: [Channel]}` |
| POST | `/api/channels` | `{name, topic?, is_private?}` | `201 {channel}` |
| GET | `/api/channels/{id}` | – | `200 {channel}` (includes `members`) |
| PATCH | `/api/channels/{id}` | `{name?, topic?}` | `200 {channel}` |
| POST | `/api/channels/{id}/join` | – | `200 {channel}` |
| POST | `/api/channels/{id}/leave` | – | `204` |
| POST | `/api/channels/{id}/members` | `{user_id}` | `204` |
| DELETE | `/api/channels/{id}/members/{userID}` | – | `204` |
| POST | `/api/channels/{id}/read` | `{last_message_id}` | `204` |
| POST | `/api/channels/{id}/mute` | `{muted}` | `204` — per-member, suppresses push |
| POST | `/api/channels/{id}/typing` | – | `204` |
| POST | `/api/dms` | `{user_id}` | `200 {channel}` — get-or-create |

`unread_count` is capped at 100: counting exactly would mean scanning all
history on every call, so the server stops there and clients render anything at
the cap as "99+". The same cap applies to the push badge total.

`GET /api/channels` returns **all** public channels (so the browser/Ctrl-K can
list ones you have not joined) plus private channels you belong to. `dms` holds
only DM channels you belong to that have at least one message or were opened by
you.

Channel names: lowercase, 1–40 chars, `[a-z0-9-_]`, unique. The server
normalises (lowercases, spaces → `-`). Duplicate name → `409 conflict`.

Only the creator or an admin may rename/retopic a channel or remove members.
DM channels cannot be renamed, joined, or left.

## Messages

| Method | Path | Body | Response |
|---|---|---|---|
| GET | `/api/channels/{id}/messages?before=&after=&limit=` | – | `200 {messages: [Message], has_more}` |
| POST | `/api/channels/{id}/messages` | `{body, attachment_ids?: [], client_id?}` | `201 {message}` |
| PATCH | `/api/messages/{id}` | `{body}` | `200 {message}` |
| DELETE | `/api/messages/{id}` | – | `204` (soft delete) |
| PUT | `/api/messages/{id}/reactions/{emoji}` | – | `204` |
| DELETE | `/api/messages/{id}/reactions/{emoji}` | – | `204` |

- `limit` defaults to 50, max 200. Messages come back **oldest → newest**.
- `before=<id>` returns messages older than that id (scroll-back);
  `after=<id>` returns newer ones (gap-fill after reconnect).
- A message needs a non-empty `body` **or** at least one attachment.
- Body max 8000 chars. Only the author may edit; author or admin may delete.
- Soft-deleted messages come back with `deleted_at` set and `body: ""`.
- `{emoji}` is URL-encoded; server caps it at 24 bytes.
- Posting a message joins the sender to a public channel automatically.

## Files

| Method | Path | Body | Response |
|---|---|---|---|
| POST | `/api/uploads` | multipart, field `file` | `201 {attachment}` |
| GET | `/api/channels/{id}/attachments` | `?before=<attachment id>&limit=` | `200 {attachments, has_more}` |
| GET | `/api/files/{id}/{variant}/{filename}` | – | file bytes |

Uploads are not attached to a message until one references the id. Only the
uploader may reference an unattached attachment. Downloads require the caller
to be able to read the message's channel. Non-image downloads are served
`Content-Disposition: attachment`.

`/api/channels/{id}/attachments` pages a channel's attachments newest first
(deleted messages excluded), with the same read access as message history.
Each element is an Attachment plus `user_id` and `created_at` from its message.

## Search

`GET /api/search?q=<query>&limit=<n>` → `200 {results: [SearchResult]}`

```jsonc
{ "message": Message, "channel_id": 12, "channel_name": "design",
  "channel_kind": "channel", "user_id": 3, "user_name": "Ana",
  "snippet": "…a <mark>pixel</mark> perfect…" }
```

Query grammar — filters may appear anywhere, remaining words are the text:

- `from:@ana` or `from:ana` — messages by that display name (case-insensitive).
- `in:#design` or `in:design` — messages in that channel.
- Everything else is full-text (Postgres `websearch_to_tsquery`), with every
  word also matched by prefix (`anthropi` finds "anthropic") — the tsvector
  stores unstemmed `simple` lexemes alongside the stemmed `english` ones so
  partially-typed words land. URLs, emails and other dotted/slashed strings are
  also indexed by their parts, so `research` finds a message containing
  `www.research.example.co.uk`. Quoted phrases, `or` and `-negation` keep their
  websearch meaning.

Results are limited to channels the caller can read, newest first, default
limit 30 (max 100). `snippet` is server-rendered with `ts_headline`; it is
**pre-escaped HTML** where only `<mark>` tags appear — the client may insert it
with `innerHTML` after verifying nothing else is present, or render it as text.
Text-free searches (only filters) are allowed and return the latest messages
matching the filters.

## Realtime

`GET /api/events` — Server-Sent Events. Each frame is
`event: <type>` + `data: <json>`. A comment heartbeat (`: ping`) is sent every
25 seconds. The client reconnects with backoff and then gap-fills each open
channel with `after=<last known id>`.

| Event | Data |
|---|---|
| `hello` | `{user_id, client_id, online: [id], server_time, version}` — first frame; `client_id` names this stream for `/api/events/visible` |
| `message.new` | `{message: Message, channel: {id, kind, name}, user: {id, display_name}}` |
| `message.update` | `{message: Message}` |
| `message.delete` | `{message_id, channel_id}` |
| `reaction` | `{message_id, channel_id, reactions: [Reaction]}` |
| `channel.new` | `{channel: Channel}` — you were added, or a public channel was created |
| `channel.update` | `{channel: Channel}` |
| `channel.members` | `{channel_id, members: [id], member_count}` |
| `channel.read` | `{channel_id, last_read_message_id}` — from your other tabs |
| `channel.mute` | `{channel_id, muted}` — from your other tabs |
| `workspace.update` | `{workspace: {name, icon_url}}` — admin changed the branding |
| `typing` | `{channel_id, user_id}` |
| `presence` | `{user_id, online: bool}` |
| `user.update` | `{user: User}` — profile changed (name, colour, status) |

`message.new` goes to every member of the channel, including the sender (the
sender dedupes on `client_id`). Non-members of a public channel do not receive
its message events; they see the channel in the browser and get history when
they open it.

Each stream also carries a tab-visibility flag, used only to decide whether to
send web push (a hidden tab keeps its stream open but should not silence
notifications). The state at connect time comes from `GET /api/events?visible=0|1`
(default visible); later changes are reported with
`POST /api/events/visible {client_id, visible}` → `204`, where `client_id` is
the value from that stream's `hello` frame. A stale `client_id` is accepted
silently.

## Web push

| Method | Path | Body | Response |
|---|---|---|---|
| GET | `/api/push/key` | – | `200 {public_key}` (empty string if disabled) |
| POST | `/api/push/subscribe` | `{endpoint, keys: {p256dh, auth}}` | `204` |
| POST | `/api/push/unsubscribe` | `{endpoint}` | `204` |

A push is sent for a new message to each member who has **no visible tab**
(per the SSE visibility flag above — merely being connected does not count),
is not the author, and has not muted the channel. Payload
delivered to the service worker:
`{title, body, tag, url, badge}` where `url` is `/?c=<channel_id>` and `badge`
is that user's total unread count.

## External send API

For scripts: no session, no JSON, one endpoint.

```sh
curl -H "Authorization: Bearer slk_..." -d 'the build is green' \
     https://slock.example.com/api/send/releases

curl -H "Authorization: Bearer slk_..." \
     'https://slock.example.com/api/send/@bob?msg=your%20build%20finished'
```

| Method | Path | Auth | Body |
|---|---|---|---|
| POST or GET | `/api/send/{target}` | `Authorization: Bearer <token>` or `X-Auth-Token` | the message |

- `{target}` is `channel`, `#channel` or `@user` (`#` optional; percent-encode
  it as `%23` if your tooling mangles it). `@user` matches a display name and
  opens the DM if it does not exist yet.
- The message is the **request body**, or `?msg=` if that is easier. Both are
  percent-decoded normally, so newlines and emoji work.
- Responses are plain text: `201` with `ok <message id>`, otherwise a 4xx with
  one line saying why.
- The token goes in a **header, never the URL** — query strings end up in proxy
  logs and browser history.
- Messages post as the token's own bot user, so they render with the token's
  name and appear in realtime, unread counts and push exactly like any other.

Tokens are managed by admins:

| Method | Path | Body | Response |
|---|---|---|---|
| GET | `/api/admin/tokens` | – | `200 {tokens: [APIToken]}` |
| POST | `/api/admin/tokens` | `{name, scope}` | `201 {api_token, token}` — secret shown **once** |
| PATCH | `/api/admin/tokens/{id}` | `{name?, scope?, is_active?}` | `200 {api_token}` |
| DELETE | `/api/admin/tokens/{id}` | – | `204` |

```jsonc
// APIToken — the secret is never returned again after creation.
{ "id": 3, "name": "Deploy bot", "scope": "#eng, @bob, #releases",
  "is_active": true, "user_id": 12, "created_at": "...", "last_used_at": "..." }
```

`scope` is `*` for anywhere, or a comma/space separated list of `#channel` and
`@user` entries; a bare word is read as a channel. The server normalises it, so
`eng, @Bob` is stored as `#eng, @bob`. A channel entry never authorises the DM
of the same name, or vice versa. Only `sha256(token)` is stored.

Creating a token also creates the bot account it posts as (`is_bot`). Bots
cannot sign in, appear in `/api/users` so their name renders, and are excluded
from `/api/admin/users` because they are managed here instead. Deleting a token
leaves the bot and its messages: removing the user would erase history.

## Admin

| Method | Path | Body | Response |
|---|---|---|---|
| GET | `/api/admin/users` | – | `200 {users: [User]}` — includes inactive, with emails |
| POST | `/api/admin/users` | `{email, display_name, is_admin?}` | `201 {user, temp_password}` |
| PATCH | `/api/admin/users/{id}` | `{display_name?, is_admin?, is_active?}` | `200 {user}` |
| POST | `/api/admin/users/{id}/reset-password` | – | `200 {temp_password}` |

New users get a random temporary password returned **once** to the admin (the
plan is that the admin passes it on by hand) and `must_change_pw = true`. If
SendGrid is configured a welcome mail is also attempted, best-effort. New users
are auto-joined to `#general`. Admins cannot deactivate or demote themselves.
