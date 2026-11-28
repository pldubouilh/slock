-- 0014: search ignores diacritics: "lea" finds "Léa", and "Léa" finds "Lea".
--
-- The unaccent dictionary (contrib, shipped with the postgres images; a trusted
-- extension since Postgres 13, so the database owner may create it) goes in
-- front of the usual dictionaries in two text search configurations, copies of
-- english and simple. Indexing and queries both go through them, so accents
-- fold on both sides, and ts_headline with the same configuration still marks
-- the word as written ("<mark>Léa</mark>"). Only word types holding non-ASCII
-- letters need it (asciiword has nothing to fold).
--
-- The URL-parts arm (0005) split on anything outside [a-zA-Z0-9], which cut
-- "Léa" into "L a"; it now splits on anything that is not a letter or digit.
-- Rebuilding the generated column rewrites the table, as 0005 did.
CREATE EXTENSION IF NOT EXISTS unaccent;

CREATE TEXT SEARCH CONFIGURATION slock_english (COPY = english);
ALTER TEXT SEARCH CONFIGURATION slock_english
    ALTER MAPPING FOR word, hword, hword_part WITH unaccent, english_stem;

CREATE TEXT SEARCH CONFIGURATION slock_simple (COPY = simple);
ALTER TEXT SEARCH CONFIGURATION slock_simple
    ALTER MAPPING FOR word, hword, hword_part WITH unaccent, simple;

ALTER TABLE messages DROP COLUMN search_tsv;
ALTER TABLE messages ADD COLUMN search_tsv tsvector
    GENERATED ALWAYS AS (
        to_tsvector('slock_english', body)
        || to_tsvector('slock_simple', body)
        || to_tsvector('slock_simple', regexp_replace(body, '[^[:alnum:]]+', ' ', 'g'))
    ) STORED;
CREATE INDEX IF NOT EXISTS messages_search_idx ON messages USING GIN (search_tsv);
