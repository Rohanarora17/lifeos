-- src/lib/migrations/026_calendar_sync.sql

-- Add calendar_event_id to soft_watch_commitments
ALTER TABLE soft_watch_commitments ADD COLUMN calendar_event_id TEXT DEFAULT NULL;
