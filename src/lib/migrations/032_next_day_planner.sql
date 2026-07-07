-- Next-day planner: adaptive daily plans plus planned focus sessions.

CREATE TABLE IF NOT EXISTS daily_plans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  plan_date TEXT NOT NULL UNIQUE,
  source_checkin_id INTEGER REFERENCES daily_checkins(id) ON DELETE SET NULL,
  sleep_time TEXT,
  wake_estimate TEXT,
  mood TEXT,
  energy TEXT,
  evening_notes TEXT,
  tomorrow_intention TEXT,
  generated_summary TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('draft','active','archived')),
  created_at TEXT DEFAULT (datetime('now', 'localtime')),
  updated_at TEXT DEFAULT (datetime('now', 'localtime'))
);

CREATE INDEX IF NOT EXISTS idx_daily_plans_date ON daily_plans(plan_date DESC);

CREATE TABLE IF NOT EXISTS planned_focus_sessions (
  id TEXT PRIMARY KEY,
  plan_id INTEGER NOT NULL REFERENCES daily_plans(id) ON DELETE CASCADE,
  task_id INTEGER REFERENCES tasks(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  planned_start TEXT NOT NULL,
  planned_end TEXT NOT NULL,
  duration_minutes INTEGER NOT NULL,
  session_type TEXT NOT NULL DEFAULT 'study',
  rule_json TEXT NOT NULL DEFAULT '{}',
  reward_xp INTEGER NOT NULL DEFAULT 0,
  reward_coins INTEGER NOT NULL DEFAULT 0,
  calendar_event_id TEXT,
  calendar_status TEXT NOT NULL DEFAULT 'not_configured' CHECK(calendar_status IN ('not_configured','created','synced','failed','deleted')),
  soft_watch_id TEXT,
  status TEXT NOT NULL DEFAULT 'planned' CHECK(status IN ('planned','started','completed','skipped','cancelled')),
  created_at TEXT DEFAULT (datetime('now', 'localtime')),
  updated_at TEXT DEFAULT (datetime('now', 'localtime'))
);

CREATE INDEX IF NOT EXISTS idx_planned_focus_sessions_plan ON planned_focus_sessions(plan_id, planned_start);
CREATE INDEX IF NOT EXISTS idx_planned_focus_sessions_task ON planned_focus_sessions(task_id, planned_start);
CREATE INDEX IF NOT EXISTS idx_planned_focus_sessions_status ON planned_focus_sessions(status, planned_start);
