-- 0008: web push outbox.
--
-- A pending push is a row, not an in-memory timer: grace-delayed
-- notifications survive a restart, failed sends can retry, and any number of
-- server instances can drain the queue without double-sending (the worker
-- claims rows with FOR UPDATE SKIP LOCKED). One row per (user, channel) is
-- the coalescing rule — a newer message replaces the payload of a pending
-- push instead of queueing behind it, mirroring what the Topic header does
-- inside the push service. The payload itself is NOT stored: only message_id,
-- so delivery renders fresh text (edits and renames included) and a message
-- deleted before delivery pushes nothing.
CREATE TABLE IF NOT EXISTS push_queue (
    user_id       BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    channel_id    BIGINT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    message_id    BIGINT NOT NULL,
    deliver_after TIMESTAMPTZ NOT NULL,
    attempts      SMALLINT NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, channel_id)
);
CREATE INDEX IF NOT EXISTS push_queue_due_idx ON push_queue (deliver_after);
