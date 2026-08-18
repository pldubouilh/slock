-- 0001: the baseline schema.
--
-- Every statement is CREATE ... IF NOT EXISTS, so this applies cleanly both to
-- an empty database and to one created before migrations existed (it simply
-- records itself as applied and changes nothing).
--
-- APPLIED MIGRATIONS ARE IMMUTABLE. Editing this file after it has run
-- somewhere will trip the checksum guard on the next boot. Add a new numbered
-- file instead.

CREATE TABLE IF NOT EXISTS users (
    id                BIGSERIAL PRIMARY KEY,
    email             TEXT NOT NULL,
    display_name      TEXT NOT NULL,
    password_hash     TEXT NOT NULL,
    avatar_color      SMALLINT NOT NULL DEFAULT 0,
    avatar_sha        TEXT NOT NULL DEFAULT '',
    status_text       TEXT NOT NULL DEFAULT '',
    is_admin          BOOLEAN NOT NULL DEFAULT FALSE,
    is_active         BOOLEAN NOT NULL DEFAULT TRUE,
    must_change_pw    BOOLEAN NOT NULL DEFAULT FALSE,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS users_email_key ON users (lower(email));

CREATE TABLE IF NOT EXISTS sessions (
    token_hash  BYTEA PRIMARY KEY,
    user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at  TIMESTAMPTZ NOT NULL,
    user_agent  TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions (user_id);

CREATE TABLE IF NOT EXISTS password_resets (
    token_hash  BYTEA PRIMARY KEY,
    user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at  TIMESTAMPTZ NOT NULL,
    used_at     TIMESTAMPTZ
);

-- kind: 'channel' | 'dm'
CREATE TABLE IF NOT EXISTS channels (
    id          BIGSERIAL PRIMARY KEY,
    kind        TEXT NOT NULL DEFAULT 'channel',
    name        TEXT NOT NULL DEFAULT '',
    topic       TEXT NOT NULL DEFAULT '',
    is_private  BOOLEAN NOT NULL DEFAULT FALSE,
    dm_key      TEXT,
    created_by  BIGINT REFERENCES users(id) ON DELETE SET NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_message_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS channels_name_key ON channels (lower(name)) WHERE kind = 'channel';
CREATE UNIQUE INDEX IF NOT EXISTS channels_dm_key ON channels (dm_key) WHERE dm_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS channel_members (
    channel_id           BIGINT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    user_id              BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    joined_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_read_message_id BIGINT NOT NULL DEFAULT 0,
    muted                BOOLEAN NOT NULL DEFAULT FALSE,
    PRIMARY KEY (channel_id, user_id)
);
CREATE INDEX IF NOT EXISTS channel_members_user_idx ON channel_members (user_id);

CREATE TABLE IF NOT EXISTS messages (
    id          BIGSERIAL PRIMARY KEY,
    channel_id  BIGINT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    body        TEXT NOT NULL DEFAULT '',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    edited_at   TIMESTAMPTZ,
    deleted_at  TIMESTAMPTZ,
    search_tsv  tsvector GENERATED ALWAYS AS (to_tsvector('english', body)) STORED
);
CREATE INDEX IF NOT EXISTS messages_channel_idx ON messages (channel_id, id DESC);
CREATE INDEX IF NOT EXISTS messages_search_idx ON messages USING GIN (search_tsv);
CREATE INDEX IF NOT EXISTS messages_user_idx ON messages (user_id);

CREATE TABLE IF NOT EXISTS attachments (
    id           BIGSERIAL PRIMARY KEY,
    message_id   BIGINT REFERENCES messages(id) ON DELETE CASCADE,
    uploader_id  BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    filename     TEXT NOT NULL,
    mime         TEXT NOT NULL,
    size_bytes   BIGINT NOT NULL,
    sha256       TEXT NOT NULL,
    is_image     BOOLEAN NOT NULL DEFAULT FALSE,
    width        INT NOT NULL DEFAULT 0,
    height       INT NOT NULL DEFAULT 0,
    has_display  BOOLEAN NOT NULL DEFAULT FALSE,
    has_thumb    BOOLEAN NOT NULL DEFAULT FALSE,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS attachments_message_idx ON attachments (message_id);

CREATE TABLE IF NOT EXISTS reactions (
    message_id  BIGINT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    emoji       TEXT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (message_id, user_id, emoji)
);

CREATE TABLE IF NOT EXISTS push_subscriptions (
    id          BIGSERIAL PRIMARY KEY,
    user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    endpoint    TEXT NOT NULL UNIQUE,
    p256dh      TEXT NOT NULL,
    auth        TEXT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    failed_at   TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS push_subs_user_idx ON push_subscriptions (user_id);

CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
