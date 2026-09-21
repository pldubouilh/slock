-- 0011: idempotent sends.
--
-- The client stamps each send with a unique client_id; storing it and making
-- (user_id, client_id) unique lets a retried POST — a browser transparently
-- re-sending over a flaky connection, or a manual retry — resolve to the one
-- message instead of inserting a duplicate. Empty client_id (a bot, an older
-- client) is excluded from the constraint so those are never deduped.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS client_id TEXT NOT NULL DEFAULT '';
CREATE UNIQUE INDEX IF NOT EXISTS messages_user_client_id_key
    ON messages (user_id, client_id) WHERE client_id <> '';
