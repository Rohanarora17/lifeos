CREATE TABLE IF NOT EXISTS telegram_processed_updates (
  update_id INTEGER PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'processing' CHECK(status IN ('processing','completed')),
  claimed_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_telegram_processed_updates_status
  ON telegram_processed_updates(status, updated_at);
