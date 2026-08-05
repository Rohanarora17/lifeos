-- Static work cannot be classified reliably from input events alone. Persist a
-- user-confirmation loop and keep uncertain evidence out of scoring until the
-- user resolves it.

CREATE TABLE IF NOT EXISTS guardian_presence_checks (
  check_id              TEXT PRIMARY KEY,
  session_id            TEXT NOT NULL REFERENCES guardian_sessions(session_id) ON DELETE CASCADE,
  uncertain_started_at  INTEGER NOT NULL,
  asked_at              INTEGER NOT NULL,
  response_deadline_at  INTEGER NOT NULL,
  resolved_at           INTEGER,
  resolution            TEXT CHECK(resolution IN ('still_working','break','end','timeout')),
  app                    TEXT,
  window_title           TEXT,
  evidence_json          TEXT NOT NULL DEFAULT '{}',
  created_at             TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_guardian_presence_pending
  ON guardian_presence_checks(session_id, resolved_at, response_deadline_at);

ALTER TABLE session_activity_intervals ADD COLUMN engagement_state TEXT NOT NULL DEFAULT 'interactive';
ALTER TABLE session_activity_intervals ADD COLUMN engagement_confidence REAL;
ALTER TABLE session_activity_intervals ADD COLUMN presence_check_id TEXT REFERENCES guardian_presence_checks(check_id) ON DELETE SET NULL;
ALTER TABLE session_activity_intervals ADD COLUMN confirmation_status TEXT;
