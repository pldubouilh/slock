-- 0006: server-managed keypairs live in the database.
--
-- The Web Push (VAPID) keypair is generated state, not a human decision, and
-- it is meaningless apart from the push_subscriptions rows bound to it: every
-- subscription a browser makes is welded to that public key, so a keypair that
-- can drift away from the database (a config file that fails to save, is not
-- restored alongside a dump, or differs per instance) silently invalidates
-- every subscription. Keeping it here makes the pair travel with the rows it
-- belongs to, and lets concurrent boots agree via ON CONFLICT.
CREATE TABLE IF NOT EXISTS server_keys (
    name        TEXT PRIMARY KEY,
    public_key  TEXT NOT NULL,
    private_key TEXT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
