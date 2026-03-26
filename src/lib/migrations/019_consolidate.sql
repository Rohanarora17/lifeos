-- Consolidation: guardian_session_summaries is the single source of truth for sessions.
-- focus_sessions is eliminated. Add started_at to summaries for time-of-day analysis.

ALTER TABLE guardian_session_summaries ADD COLUMN started_at TEXT DEFAULT NULL;

-- Drop the legacy focus_sessions table (all consumers have been migrated).
DROP TABLE IF EXISTS focus_sessions;
