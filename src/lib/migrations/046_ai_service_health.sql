CREATE TABLE IF NOT EXISTS ai_service_health (
  service TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK(status IN ('healthy', 'failed')),
  model TEXT,
  failure_code TEXT,
  message TEXT,
  first_failure_at TEXT,
  last_failure_at TEXT,
  last_success_at TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
