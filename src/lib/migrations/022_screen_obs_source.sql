-- Migration 022: extend screen_observations source CHECK to include extension sources
-- The original CHECK only allowed 'screenshot' | 'daemon'.
-- Extension screenshots (captureAndAnalyzeBuffer) pass 'extension_screenshot',
-- and the daemon ingest route passes 'extension_screenshot' too — these must be valid.
--
-- NOTE: No explicit BEGIN/COMMIT — db.ts migration runner wraps each file in a transaction.
-- NOTE: No PRAGMA foreign_keys OFF — better-sqlite3 does not allow PRAGMAs inside transactions.

-- SQLite cannot ALTER a CHECK constraint in-place, so we recreate the table.

CREATE TABLE IF NOT EXISTS screen_observations (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  observed_at         TEXT    NOT NULL,
  source              TEXT    NOT NULL DEFAULT 'screenshot'
                              CHECK(source IN ('screenshot','daemon','extension_screenshot','extension_daemon')),
  app                 TEXT,
  window_title        TEXT,
  activity            TEXT,
  category            TEXT    CHECK(category IN ('deep_work','shallow_work','communication','consumption','distraction','idle')),
  content_type        TEXT,
  attention_quality   TEXT    CHECK(attention_quality IN ('focused','browsing','consuming','distracted','idle')),
  specific_content    TEXT,
  productive_for_goals INTEGER DEFAULT 0,
  confidence          REAL    DEFAULT 0.8,
  session_id          TEXT    REFERENCES guardian_sessions(session_id),
  raw_description     TEXT
);

CREATE TABLE screen_observations_new (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  observed_at         TEXT    NOT NULL,
  source              TEXT    NOT NULL DEFAULT 'screenshot'
                              CHECK(source IN ('screenshot','daemon','extension_screenshot','extension_daemon')),
  app                 TEXT,
  window_title        TEXT,
  activity            TEXT,
  category            TEXT    CHECK(category IN ('deep_work','shallow_work','communication','consumption','distraction','idle')),
  content_type        TEXT,
  attention_quality   TEXT    CHECK(attention_quality IN ('focused','browsing','consuming','distracted','idle')),
  specific_content    TEXT,
  productive_for_goals INTEGER DEFAULT 0,
  confidence          REAL    DEFAULT 0.8,
  session_id          TEXT    REFERENCES guardian_sessions(session_id),
  raw_description     TEXT
);

INSERT INTO screen_observations_new
SELECT id, observed_at, source, app, window_title, activity, category,
       content_type, attention_quality, specific_content, productive_for_goals,
       confidence, session_id, raw_description
FROM screen_observations;

DROP TABLE screen_observations;
ALTER TABLE screen_observations_new RENAME TO screen_observations;

CREATE INDEX IF NOT EXISTS idx_screen_obs_observed_at ON screen_observations(observed_at DESC);
