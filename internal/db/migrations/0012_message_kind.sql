-- 0012: system (activity) messages.
--
-- kind = 'user' (the default, every existing message) is a normal message;
-- kind = 'system' is a channel-lifecycle note — created, renamed, made
-- public/private, someone joined — rendered as an ambient line. System
-- messages live in history like any other but never count as unread and never
-- trigger web push.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'user';
