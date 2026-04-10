-- 023: Goals column backfill (no-op)
-- Column additions (archived, category, deadline) and data sync are
-- handled safely by the try-catch backfills in db.ts initSchema().
-- This file exists only to record the migration as applied.
SELECT 1;
