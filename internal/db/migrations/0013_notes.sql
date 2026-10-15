-- 0013: shared notes.
--
-- A note is a channel of kind = 'note': membership, privacy, invites, renames
-- and deletion work as for named channels, but instead of messages it holds
-- one plain text, edited by several people at once. Notes start private.
--
-- notes.body is the current text and notes.rev counts the edits applied to
-- it. Every edit is kept in note_ops (an operational-transform operation, see
-- internal/api/notes.go) so an edit made against an older revision can be
-- rebased over the ones that landed since, and so a client that missed some
-- can fetch them. Old ops are pruned; a client that far behind reloads.
CREATE TABLE IF NOT EXISTS notes (
    channel_id  BIGINT PRIMARY KEY REFERENCES channels(id) ON DELETE CASCADE,
    body        TEXT NOT NULL DEFAULT '',
    rev         BIGINT NOT NULL DEFAULT 0,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_by  BIGINT REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS note_ops (
    channel_id  BIGINT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    rev         BIGINT NOT NULL,
    user_id     BIGINT REFERENCES users(id) ON DELETE SET NULL,
    -- the sender's id for this edit, so a retried send is applied once
    client_op   TEXT NOT NULL DEFAULT '',
    op          JSONB NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (channel_id, rev)
);
CREATE INDEX IF NOT EXISTS note_ops_client_idx ON note_ops (channel_id, client_op) WHERE client_op <> '';

-- Everyone gets a "Personal note". It replaces the old Notes (the DM with
-- yourself): what was written there is gathered into the note, oldest first,
-- one message per paragraph, attachments named in brackets. The self-DM and
-- its messages and files stay as they were; the app just no longer shows it.
WITH src AS (
    SELECT u.id AS user_id,
           COALESCE((
               SELECT string_agg(btrim(m.body || COALESCE(att.files, ''), E' \n'), E'\n\n' ORDER BY m.id)
                 FROM channels d
                 JOIN messages m ON m.channel_id = d.id
                 LEFT JOIN LATERAL (
                     SELECT string_agg(E'\n[' || a.filename || ']', '' ORDER BY a.id) AS files
                       FROM attachments a WHERE a.message_id = m.id
                 ) att ON TRUE
                WHERE d.kind = 'dm' AND d.dm_key = u.id || ':' || u.id
                  AND m.deleted_at IS NULL AND m.kind = 'user'
           ), '') AS body
      FROM users u
     WHERE NOT u.is_bot
       AND NOT EXISTS (SELECT 1 FROM channels c WHERE c.kind = 'note' AND c.created_by = u.id)
), made AS (
    INSERT INTO channels (kind, name, is_private, created_by)
    SELECT 'note', 'Personal note', TRUE, user_id FROM src
    RETURNING id, created_by
), joined AS (
    INSERT INTO channel_members (channel_id, user_id)
    SELECT id, created_by FROM made
)
INSERT INTO notes (channel_id, body, updated_by)
SELECT made.id, src.body, made.created_by
  FROM made JOIN src ON src.user_id = made.created_by;
