CREATE TABLE IF NOT EXISTS guardian_voice_leases (
  session_id TEXT PRIMARY KEY REFERENCES guardian_sessions(session_id) ON DELETE CASCADE,
  issued_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  window_started_at INTEGER NOT NULL,
  issue_count INTEGER NOT NULL DEFAULT 1,
  released_at INTEGER DEFAULT NULL
);

CREATE TABLE IF NOT EXISTS guardian_voice_daily_usage (
  usage_date TEXT PRIMARY KEY,
  authorized_minutes INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT DEFAULT (datetime('now', 'localtime'))
);

CREATE INDEX IF NOT EXISTS idx_guardian_voice_leases_active
  ON guardian_voice_leases(expires_at, released_at);
