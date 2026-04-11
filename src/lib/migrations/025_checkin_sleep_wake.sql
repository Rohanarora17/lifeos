-- Migration 025: Sleep/wake/intention columns on daily_checkins
-- These columns are added via try/catch backfills in db.ts (initSchema)
-- because SQLite has no ALTER TABLE ... ADD COLUMN IF NOT EXISTS.
-- Running raw ALTER TABLE inside a transaction would crash on existing DBs
-- that already have these columns. The backfills below in db.ts are idempotent.
-- This file is intentionally a no-op so the migration is recorded as applied.
SELECT 1;
