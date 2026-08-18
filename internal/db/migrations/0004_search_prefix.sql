-- 0004: prefix-friendly search.
--
-- The english config stores stems ('anthropic' becomes 'anthrop'), so a
-- prefix query longer than the stem ('anthropi:*') could never match. Storing
-- the simple (unstemmed, lowercased) lexemes alongside the english ones lets
-- partially-typed words land while stemmed whole-word search keeps working.
-- Rebuilding the generated column rewrites the table; message tables are small
-- enough that this is fine at boot.
ALTER TABLE messages DROP COLUMN search_tsv;
ALTER TABLE messages ADD COLUMN search_tsv tsvector
    GENERATED ALWAYS AS (to_tsvector('english', body) || to_tsvector('simple', body)) STORED;
CREATE INDEX IF NOT EXISTS messages_search_idx ON messages USING GIN (search_tsv);
