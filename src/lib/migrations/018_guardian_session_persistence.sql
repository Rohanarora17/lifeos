-- Persist active guardian sessions so they survive server restarts.
-- Previously sessions were purely in-memory; a server restart lost the active session,
-- causing the browser extension to see no active session and stop tracking entirely.
CREATE TABLE IF NOT EXISTS guardian_sessions (
  session_id       TEXT PRIMARY KEY,
  target_title     TEXT,
  goal_id          TEXT,
  goal_title       TEXT,
  concept_node_name TEXT,
  started_at       INTEGER NOT NULL,       -- Unix ms
  duration_minutes INTEGER NOT NULL DEFAULT 60,
  mood             TEXT,
  state            TEXT NOT NULL DEFAULT 'ACTIVE'
                     CHECK(state IN ('ACTIVE','BREAK','COMPLETE','ABANDONED')),
  created_at       TEXT DEFAULT (datetime('now','localtime'))
);
