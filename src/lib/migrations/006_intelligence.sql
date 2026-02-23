-- Phase 11: Real-Time Alerts & Notification System

CREATE TABLE IF NOT EXISTS alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  message TEXT NOT NULL,
  severity TEXT DEFAULT 'info' CHECK(severity IN ('info', 'warning', 'urgent')),
  read INTEGER DEFAULT 0,
  emailed INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_alerts_unread ON alerts(read, created_at);

-- Implementation intentions (Phase 15)
CREATE TABLE IF NOT EXISTS intentions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  if_condition TEXT NOT NULL,
  then_action TEXT NOT NULL,
  goal_id INTEGER DEFAULT NULL REFERENCES goals(id),
  active INTEGER DEFAULT 1,
  times_triggered INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Task priority (Phase 13)
ALTER TABLE tasks ADD COLUMN priority TEXT DEFAULT 'medium';
