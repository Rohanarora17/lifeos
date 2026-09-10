-- Closed-loop coaching: persist each commitment from planned start through
-- measured session outcome, and attach intervention choices to that lifecycle.

CREATE TABLE IF NOT EXISTS coaching_commitments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  commitment_key TEXT NOT NULL UNIQUE,
  source_type TEXT NOT NULL
    CHECK(source_type IN ('planned_focus', 'soft_watch', 'recovery')),
  source_id TEXT NOT NULL,
  episode_id TEXT REFERENCES coaching_episodes(id) ON DELETE SET NULL,
  task_id INTEGER REFERENCES tasks(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  planned_start_at TEXT NOT NULL,
  planned_minutes INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'scheduled'
    CHECK(state IN ('scheduled', 'due', 'missed', 'started', 'completed', 'abandoned', 'rescheduled', 'cancelled')),
  session_id TEXT,
  intervention_decision_id INTEGER REFERENCES coaching_decisions(id) ON DELETE SET NULL,
  acknowledged_at TEXT,
  started_at TEXT,
  completed_at TEXT,
  last_intervention_at TEXT,
  start_delay_seconds INTEGER,
  elapsed_minutes INTEGER,
  focus_score REAL,
  completion_ratio REAL,
  outcome_score REAL,
  outcome_reason TEXT,
  blocker_kind TEXT,
  blocker_text TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_coaching_commitments_state_start
  ON coaching_commitments(state, planned_start_at);
CREATE INDEX IF NOT EXISTS idx_coaching_commitments_session
  ON coaching_commitments(session_id);
CREATE INDEX IF NOT EXISTS idx_coaching_commitments_source
  ON coaching_commitments(source_type, source_id);

ALTER TABLE coaching_decisions ADD COLUMN commitment_id INTEGER
  REFERENCES coaching_commitments(id) ON DELETE SET NULL;
ALTER TABLE coaching_decisions ADD COLUMN variant TEXT;
ALTER TABLE coaching_decisions ADD COLUMN context_key TEXT;
ALTER TABLE coaching_decisions ADD COLUMN outcome_score REAL;
ALTER TABLE coaching_decisions ADD COLUMN evaluated_at TEXT;

CREATE INDEX IF NOT EXISTS idx_coaching_decisions_commitment
  ON coaching_decisions(commitment_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_coaching_decisions_learning
  ON coaching_decisions(action_type, context_key, variant, evaluated_at);
