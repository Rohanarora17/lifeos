ALTER TABLE daily_checkins ADD COLUMN applies_to_plan_date TEXT;

UPDATE daily_checkins
SET applies_to_plan_date = substr(
  raw_transcript,
  instr(raw_transcript, 'Planning date: ') + length('Planning date: '),
  10
)
WHERE applies_to_plan_date IS NULL
  AND raw_transcript LIKE '%Planning date: ____-__-__%';

CREATE INDEX IF NOT EXISTS idx_daily_checkins_plan_date
  ON daily_checkins(applies_to_plan_date, checkin_type, received_at DESC);

ALTER TABLE daily_plans ADD COLUMN generation_source TEXT NOT NULL DEFAULT 'legacy';

CREATE TABLE IF NOT EXISTS plan_constraints (
  id TEXT PRIMARY KEY,
  plan_id INTEGER NOT NULL REFERENCES daily_plans(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  source_text TEXT NOT NULL,
  source_checkin_id INTEGER REFERENCES daily_checkins(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','superseded','cancelled')),
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE INDEX IF NOT EXISTS idx_plan_constraints_plan_status
  ON plan_constraints(plan_id, status, start_time);

ALTER TABLE planned_focus_sessions ADD COLUMN origin TEXT NOT NULL DEFAULT 'legacy';
ALTER TABLE planned_focus_sessions ADD COLUMN invalidated_reason TEXT;
ALTER TABLE planned_focus_sessions ADD COLUMN invalidated_at TEXT;

CREATE INDEX IF NOT EXISTS idx_planned_focus_sessions_integrity
  ON planned_focus_sessions(status, planned_end, task_id);

CREATE TRIGGER IF NOT EXISTS domain_revision_plan_constraints_ai AFTER INSERT ON plan_constraints BEGIN
  UPDATE domain_revisions SET revision=revision+1, updated_at=datetime('now') WHERE scope='global';
END;
CREATE TRIGGER IF NOT EXISTS domain_revision_plan_constraints_au AFTER UPDATE ON plan_constraints BEGIN
  UPDATE domain_revisions SET revision=revision+1, updated_at=datetime('now') WHERE scope='global';
END;
CREATE TRIGGER IF NOT EXISTS domain_revision_plan_constraints_ad AFTER DELETE ON plan_constraints BEGIN
  UPDATE domain_revisions SET revision=revision+1, updated_at=datetime('now') WHERE scope='global';
END;
