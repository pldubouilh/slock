-- 0005: make the parts of URLs, emails and dotted identifiers searchable.
--
-- Postgres's text-search parser indexes "www.research.example.co.uk" as one host
-- token, so a search for "research" (a piece of it) can never match. Adding a
-- third tsvector component built from a copy of the body where every run of
-- non-alphanumeric characters is turned into a space breaks such strings into
-- their individual words ("www research example co uk"), which the prefix-query
-- arm then matches. The two existing components (stemmed english + whole-word
-- simple) are kept, so ordinary and whole-URL search are unaffected.
-- Rebuilding the generated column rewrites the table; small enough at boot.
ALTER TABLE messages DROP COLUMN search_tsv;
ALTER TABLE messages ADD COLUMN search_tsv tsvector
    GENERATED ALWAYS AS (
        to_tsvector('english', body)
        || to_tsvector('simple', body)
        || to_tsvector('simple', regexp_replace(body, '[^a-zA-Z0-9]+', ' ', 'g'))
    ) STORED;
CREATE INDEX IF NOT EXISTS messages_search_idx ON messages USING GIN (search_tsv);
