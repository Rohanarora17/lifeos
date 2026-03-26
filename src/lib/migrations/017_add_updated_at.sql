-- 017: Add updated_at to tasks and goals
-- Required for day-briefing sorting

PRAGMA foreign_keys = OFF;

-- Add column without a non-constant default (which SQLite rejects)
ALTER TABLE goals ADD COLUMN updated_at TEXT;
UPDATE goals SET updated_at = created_at WHERE updated_at IS NULL;

ALTER TABLE tasks ADD COLUMN updated_at TEXT;
UPDATE tasks SET updated_at = created_at WHERE updated_at IS NULL;

PRAGMA foreign_keys = ON;
