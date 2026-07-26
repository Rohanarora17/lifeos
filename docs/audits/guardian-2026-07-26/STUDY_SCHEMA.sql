-- Store this in a dedicated audit database, never data/lifeos.db.
CREATE TABLE study_days (
  study_date TEXT PRIMARY KEY,
  sleep_json TEXT NOT NULL,
  mood_json TEXT NOT NULL,
  calendar_fixture_json TEXT NOT NULL,
  plan_snapshot_json TEXT NOT NULL,
  actual_outcome_json TEXT,
  approved_real_session INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE study_predictions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  study_date TEXT NOT NULL REFERENCES study_days(study_date),
  claim_id TEXT NOT NULL,
  predicted_value_json TEXT,
  confidence REAL NOT NULL,
  evidence_json TEXT NOT NULL,
  observed_value_json TEXT,
  calibration_error REAL
);

CREATE TABLE study_corrections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  study_date TEXT NOT NULL REFERENCES study_days(study_date),
  claim_id TEXT NOT NULL,
  correction_json TEXT NOT NULL,
  surfaces_checked_json TEXT NOT NULL,
  retained_after_hours INTEGER
);

CREATE TABLE study_notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  study_date TEXT NOT NULL REFERENCES study_days(study_date),
  decision_json TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  user_rating INTEGER,
  user_reason TEXT
);

CREATE TABLE labelled_captures (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  capture_hash TEXT NOT NULL UNIQUE,
  expected_category TEXT NOT NULL,
  expected_alignment INTEGER NOT NULL,
  predicted_category TEXT,
  predicted_alignment INTEGER,
  sensitive INTEGER NOT NULL DEFAULT 0,
  static_screen INTEGER NOT NULL DEFAULT 0,
  passed_privacy INTEGER
);

CREATE TABLE voice_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  path TEXT NOT NULL CHECK(path IN ('ptt', 'realtime')),
  fixture_id TEXT NOT NULL,
  transcript TEXT,
  word_error_rate REAL,
  first_audio_ms INTEGER,
  interruption_stop_ms INTEGER,
  reconnect_ms INTEGER,
  passed INTEGER NOT NULL DEFAULT 0
);
