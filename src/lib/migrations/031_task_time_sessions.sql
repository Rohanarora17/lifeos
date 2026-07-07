-- Time-target tasks: focus sessions are the source of completion.

CREATE TABLE IF NOT EXISTS task_session_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL,
  session_title TEXT NOT NULL,
  credited_minutes INTEGER NOT NULL,
  focus_score REAL DEFAULT NULL,
  auto_completed INTEGER NOT NULL DEFAULT 0,
  credited_at TEXT DEFAULT (datetime('now', 'localtime')),
  UNIQUE(task_id, session_id)
);

CREATE INDEX IF NOT EXISTS idx_task_session_logs_task ON task_session_logs(task_id, credited_at DESC);
CREATE INDEX IF NOT EXISTS idx_task_session_logs_session ON task_session_logs(session_id);
