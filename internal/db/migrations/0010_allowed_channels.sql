-- 0010: per-user channel allowlist ("limited" users).
--
-- '*' (the default, and every existing user) means no restriction. Otherwise a
-- comma-separated list of channel names (lowercased, as normalizeChannelName
-- stores them) the user may see and open. DMs are never restricted — a limited
-- user can always message anyone. Enforced server-side on the channel list,
-- channel access, search, and realtime channel announcements.
ALTER TABLE users ADD COLUMN IF NOT EXISTS allowed_channels TEXT NOT NULL DEFAULT '*';
