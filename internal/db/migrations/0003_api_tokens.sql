-- 0003: token-based external API for posting messages.
--
-- A token posts as a real user account flagged is_bot, so its name and avatar
-- render everywhere a person's would and nothing downstream needs to know that
-- messages can come from a script. Bots cannot sign in.
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_bot BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE IF NOT EXISTS api_tokens (
    id           BIGSERIAL PRIMARY KEY,
    name         TEXT NOT NULL,
    -- sha256 of the token, never the token itself: a database leak must not
    -- hand anyone the ability to post.
    token_hash   BYTEA NOT NULL UNIQUE,
    -- The bot account this token posts as.
    user_id      BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_by   BIGINT REFERENCES users(id) ON DELETE SET NULL,
    -- Where it may post: '*' for anywhere, otherwise a comma-separated list of
    -- '#channel' and '@user' entries, e.g. '#eng, @bob, #releases'.
    scope        TEXT NOT NULL DEFAULT '*',
    is_active    BOOLEAN NOT NULL DEFAULT TRUE,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_used_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS api_tokens_user_idx ON api_tokens (user_id);
