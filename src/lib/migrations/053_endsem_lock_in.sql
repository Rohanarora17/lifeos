CREATE TABLE IF NOT EXISTS endsem_config (
  id INTEGER PRIMARY KEY CHECK(id = 1),
  checkpoint_hours TEXT NOT NULL DEFAULT '[12,16,20,22]',
  probability_finished_at TEXT,
  paused INTEGER NOT NULL DEFAULT 0 CHECK(paused IN (0,1))
);
INSERT OR IGNORE INTO endsem_config(id) VALUES(1);

CREATE TABLE IF NOT EXISTS endsem_paper_logs (
  request_id TEXT PRIMARY KEY,
  subject TEXT NOT NULL CHECK(subject IN ('probability','adsa')),
  started_at TEXT NOT NULL,
  ended_at TEXT NOT NULL,
  notes TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS endsem_days (
  date TEXT PRIMARY KEY,
  delay_until TEXT,
  delay_count INTEGER NOT NULL DEFAULT 0,
  blocker TEXT,
  review TEXT,
  next_start_at TEXT
);

CREATE TABLE IF NOT EXISTS endsem_events (
  event_key TEXT PRIMARY KEY,
  date TEXT NOT NULL,
  kind TEXT NOT NULL,
  message TEXT NOT NULL,
  study_seconds REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  telegram_sent_at TEXT,
  telegram_attempted_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_endsem_events_date ON endsem_events(date, created_at DESC);
