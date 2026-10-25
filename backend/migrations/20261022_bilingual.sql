-- PostgreSQL: run before deploying the bilingual report code.
-- SQLite uses utils/schema_migrate.py instead. New tables are created by metadata.
BEGIN;
ALTER TABLE problems ADD COLUMN IF NOT EXISTS description_en TEXT;
ALTER TABLE problems ADD COLUMN IF NOT EXISTS description_hi TEXT;
ALTER TABLE problems ADD COLUMN IF NOT EXISTS input_language VARCHAR(5) DEFAULT 'en';
ALTER TABLE problems ADD COLUMN IF NOT EXISTS drafting_mode VARCHAR(10) DEFAULT 'ai';
COMMIT;
