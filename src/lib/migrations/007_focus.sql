-- Phase 14: Focus Sessions

CREATE TABLE IF NOT EXISTS focus_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER DEFAULT NULL REFERENCES tasks(id),
  duration_minutes INTEGER NOT NULL,
  completed_at TEXT DEFAULT (datetime('now'))
);
