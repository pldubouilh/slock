-- 0007: pinned messages.
--
-- A message is pinned in its channel or it is not, so the message is the key
-- rather than (message, user): pinning is a property of the conversation, not
-- a per-person bookmark. channel_id is denormalised alongside so listing a
-- channel's pins never has to join messages just to filter, and the cascade
-- means a hard-deleted message can leave no dangling pin behind.
CREATE TABLE IF NOT EXISTS pins (
    message_id BIGINT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
    channel_id BIGINT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    user_id    BIGINT REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS pins_channel_idx ON pins (channel_id, created_at DESC);
