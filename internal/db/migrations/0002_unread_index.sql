-- 0002: make unread counting cheap.
--
-- Unread counts are asked for constantly: once per channel on every
-- /api/channels call, and once per offline recipient of every push. Without a
-- covering index Postgres reads the whole messages table for each one, so the
-- cost grows with total history forever. Measured on 300k messages: 85ms per
-- channel-list call before this index, 1.5ms after.
--
-- (channel_id, id DESC) matches "newest first within a channel"; INCLUDE
-- (user_id) lets the count skip your own messages without touching the heap;
-- the partial predicate keeps deleted rows out of the index entirely.
CREATE INDEX IF NOT EXISTS messages_unread_idx
    ON messages (channel_id, id DESC)
    INCLUDE (user_id)
    WHERE deleted_at IS NULL;
