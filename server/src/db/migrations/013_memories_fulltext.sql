-- 3.5f — Full-text search híbrido (tsvector + GIN via trigger)
-- Generated columns rejeitam to_tsvector (nao immutable em pt-br), entao usamos trigger

ALTER TABLE memories ADD COLUMN IF NOT EXISTS tsv tsvector;

CREATE OR REPLACE FUNCTION memories_tsv_update() RETURNS trigger AS $$
BEGIN
  NEW.tsv :=
    setweight(to_tsvector('portuguese', COALESCE(NEW.title, '')), 'A') ||
    setweight(to_tsvector('portuguese', COALESCE(NEW.summary, '')), 'B') ||
    setweight(to_tsvector('portuguese', COALESCE(NEW.content, '')), 'C') ||
    setweight(to_tsvector('portuguese', COALESCE(array_to_string(NEW.tags, ' '), '')), 'D');
  RETURN NEW;
END
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_memories_tsv ON memories;
CREATE TRIGGER trg_memories_tsv BEFORE INSERT OR UPDATE OF title, summary, content, tags
ON memories FOR EACH ROW EXECUTE FUNCTION memories_tsv_update();

CREATE INDEX IF NOT EXISTS idx_memories_tsv ON memories USING gin (tsv);

-- Backfill linhas existentes
UPDATE memories SET updated_at = updated_at WHERE tsv IS NULL;

SELECT COUNT(*) FILTER (WHERE tsv IS NOT NULL) AS indexed,
       COUNT(*) AS total
FROM memories;
