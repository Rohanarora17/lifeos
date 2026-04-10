-- 023: Sync goals.archived ↔ goals.active
-- ALTER TABLE ADD COLUMN statements for archived/category/deadline are handled
-- by the try-catch backfills in db.ts so they run safely on all DB versions.
-- This migration only does the idempotent data sync which is always safe to run.

UPDATE goals SET archived = CASE WHEN active = 1 THEN 0 ELSE 1 END
WHERE archived IS NULL OR (active = 0 AND archived = 0) OR (active = 1 AND archived = 1);
