CREATE TABLE IF NOT EXISTS domain_revisions (
  scope TEXT PRIMARY KEY,
  revision INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT OR IGNORE INTO domain_revisions (scope, revision) VALUES ('global', 0);

-- Older installs create this table from db.ts after numbered migrations.
-- Define the compatible shape here so revision triggers are valid on fresh DBs.
CREATE TABLE IF NOT EXISTS daily_checkins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  checkin_date TEXT NOT NULL,
  checkin_type TEXT NOT NULL CHECK(checkin_type IN ('morning','evening')),
  commitment TEXT,
  likelihood_score INTEGER,
  avoidance_honest TEXT,
  postponed_item TEXT,
  tomorrow_score INTEGER,
  tomorrow_reason TEXT,
  sleep_time TEXT,
  wake_estimate TEXT,
  tomorrow_intention TEXT,
  mood TEXT,
  energy TEXT,
  day_events TEXT,
  inferred_goal_id INTEGER,
  inferred_goal_confidence REAL,
  raw_transcript TEXT,
  memory_extracted INTEGER DEFAULT 0,
  received_at TEXT DEFAULT (datetime('now','localtime'))
);

CREATE TRIGGER IF NOT EXISTS domain_revision_tasks_ai AFTER INSERT ON tasks BEGIN
  UPDATE domain_revisions SET revision=revision+1, updated_at=datetime('now') WHERE scope='global';
END;
CREATE TRIGGER IF NOT EXISTS domain_revision_tasks_au AFTER UPDATE ON tasks BEGIN
  UPDATE domain_revisions SET revision=revision+1, updated_at=datetime('now') WHERE scope='global';
END;
CREATE TRIGGER IF NOT EXISTS domain_revision_tasks_ad AFTER DELETE ON tasks BEGIN
  UPDATE domain_revisions SET revision=revision+1, updated_at=datetime('now') WHERE scope='global';
END;

CREATE TRIGGER IF NOT EXISTS domain_revision_daily_checkins_ai AFTER INSERT ON daily_checkins BEGIN
  UPDATE domain_revisions SET revision=revision+1, updated_at=datetime('now') WHERE scope='global';
END;
CREATE TRIGGER IF NOT EXISTS domain_revision_daily_checkins_au AFTER UPDATE ON daily_checkins BEGIN
  UPDATE domain_revisions SET revision=revision+1, updated_at=datetime('now') WHERE scope='global';
END;
CREATE TRIGGER IF NOT EXISTS domain_revision_daily_checkins_ad AFTER DELETE ON daily_checkins BEGIN
  UPDATE domain_revisions SET revision=revision+1, updated_at=datetime('now') WHERE scope='global';
END;

CREATE TRIGGER IF NOT EXISTS domain_revision_daily_plans_ai AFTER INSERT ON daily_plans BEGIN
  UPDATE domain_revisions SET revision=revision+1, updated_at=datetime('now') WHERE scope='global';
END;
CREATE TRIGGER IF NOT EXISTS domain_revision_daily_plans_au AFTER UPDATE ON daily_plans BEGIN
  UPDATE domain_revisions SET revision=revision+1, updated_at=datetime('now') WHERE scope='global';
END;
CREATE TRIGGER IF NOT EXISTS domain_revision_daily_plans_ad AFTER DELETE ON daily_plans BEGIN
  UPDATE domain_revisions SET revision=revision+1, updated_at=datetime('now') WHERE scope='global';
END;

CREATE TRIGGER IF NOT EXISTS domain_revision_planned_sessions_ai AFTER INSERT ON planned_focus_sessions BEGIN
  UPDATE domain_revisions SET revision=revision+1, updated_at=datetime('now') WHERE scope='global';
END;
CREATE TRIGGER IF NOT EXISTS domain_revision_planned_sessions_au AFTER UPDATE ON planned_focus_sessions BEGIN
  UPDATE domain_revisions SET revision=revision+1, updated_at=datetime('now') WHERE scope='global';
END;
CREATE TRIGGER IF NOT EXISTS domain_revision_planned_sessions_ad AFTER DELETE ON planned_focus_sessions BEGIN
  UPDATE domain_revisions SET revision=revision+1, updated_at=datetime('now') WHERE scope='global';
END;

CREATE TRIGGER IF NOT EXISTS domain_revision_calendar_events_ai AFTER INSERT ON calendar_events BEGIN
  UPDATE domain_revisions SET revision=revision+1, updated_at=datetime('now') WHERE scope='global';
END;
CREATE TRIGGER IF NOT EXISTS domain_revision_calendar_events_au AFTER UPDATE ON calendar_events BEGIN
  UPDATE domain_revisions SET revision=revision+1, updated_at=datetime('now') WHERE scope='global';
END;
CREATE TRIGGER IF NOT EXISTS domain_revision_calendar_events_ad AFTER DELETE ON calendar_events BEGIN
  UPDATE domain_revisions SET revision=revision+1, updated_at=datetime('now') WHERE scope='global';
END;

CREATE TRIGGER IF NOT EXISTS domain_revision_soft_watches_ai AFTER INSERT ON soft_watch_commitments BEGIN
  UPDATE domain_revisions SET revision=revision+1, updated_at=datetime('now') WHERE scope='global';
END;
CREATE TRIGGER IF NOT EXISTS domain_revision_soft_watches_au AFTER UPDATE ON soft_watch_commitments BEGIN
  UPDATE domain_revisions SET revision=revision+1, updated_at=datetime('now') WHERE scope='global';
END;
CREATE TRIGGER IF NOT EXISTS domain_revision_soft_watches_ad AFTER DELETE ON soft_watch_commitments BEGIN
  UPDATE domain_revisions SET revision=revision+1, updated_at=datetime('now') WHERE scope='global';
END;

CREATE TRIGGER IF NOT EXISTS domain_revision_coaching_commitments_ai AFTER INSERT ON coaching_commitments BEGIN
  UPDATE domain_revisions SET revision=revision+1, updated_at=datetime('now') WHERE scope='global';
END;
CREATE TRIGGER IF NOT EXISTS domain_revision_coaching_commitments_au AFTER UPDATE ON coaching_commitments BEGIN
  UPDATE domain_revisions SET revision=revision+1, updated_at=datetime('now') WHERE scope='global';
END;
CREATE TRIGGER IF NOT EXISTS domain_revision_coaching_commitments_ad AFTER DELETE ON coaching_commitments BEGIN
  UPDATE domain_revisions SET revision=revision+1, updated_at=datetime('now') WHERE scope='global';
END;
