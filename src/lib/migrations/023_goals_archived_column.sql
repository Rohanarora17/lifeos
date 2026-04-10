-- 023: Add archived column to goals table
-- The goals table originally used 'active INTEGER DEFAULT 1'.
-- Voice handlers and some newer code use 'archived' instead.
-- This migration adds 'archived' as the inverse of 'active' so both work.

ALTER TABLE goals ADD COLUMN archived INTEGER DEFAULT 0;

-- Sync existing rows: archived = NOT active
UPDATE goals SET archived = CASE WHEN active = 1 THEN 0 ELSE 1 END;

-- Also add a category column if missing (used by voice create_goal)
ALTER TABLE goals ADD COLUMN category TEXT DEFAULT 'general';

-- Add deadline column if missing (used by voice create_goal and TG CREATE_GOAL)
ALTER TABLE goals ADD COLUMN deadline TEXT DEFAULT NULL;
