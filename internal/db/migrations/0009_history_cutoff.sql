-- 0009: per-user history cutoff.
--
-- NULL (everyone existing) means full history, unchanged. When set — the
-- admin ticked "only see messages from now on" at account creation — every
-- message read (history pages, search, pins, attachment lists, unread
-- counts) excludes messages created before it. The value is the moment the
-- account was created; it never moves afterwards.
ALTER TABLE users ADD COLUMN IF NOT EXISTS history_cutoff TIMESTAMPTZ;
