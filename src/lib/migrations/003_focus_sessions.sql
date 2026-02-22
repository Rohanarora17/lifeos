CREATE TABLE IF NOT EXISTS focus_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_date TEXT NOT NULL,
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  duration_minutes REAL DEFAULT 0,
  focus_type TEXT DEFAULT 'shallow' CHECK(focus_type IN ('deep', 'moderate', 'shallow', 'fragmented')),
  primary_domain TEXT,
  primary_category TEXT,
  tab_switches INTEGER DEFAULT 0,
  context_switches INTEGER DEFAULT 0,
  flow_state_detected INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_focus_date ON focus_sessions(session_date);
CREATE INDEX IF NOT EXISTS idx_focus_type ON focus_sessions(focus_type);

CREATE TABLE IF NOT EXISTS behavior_insights (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  category TEXT NOT NULL,
  insight TEXT NOT NULL,
  actionable_tip TEXT,
  severity TEXT DEFAULT 'info' CHECK(severity IN ('positive', 'info', 'warning', 'critical')),
  feedback TEXT DEFAULT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS behavior_profile (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT DEFAULT (datetime('now'))
);
