-- Migration 027: add screen vision columns + expand source CHECK to include 'screen_vision'
--
-- New columns: task_alignment, engagement_depth, distraction_indicators,
--              progress_indicator, change_magnitude
-- window_title already exists from migration 022 — not re-added.
--
-- SQLite cannot ALTER a CHECK constraint in-place, so we recreate the table.

CREATE TABLE screen_observations_v027 (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  observed_at           TEXT    NOT NULL,
  source                TEXT    NOT NULL DEFAULT 'screenshot'
                                CHECK(source IN ('screenshot','daemon','extension_screenshot','extension_daemon','screen_vision')),
  app                   TEXT,
  window_title          TEXT,
  activity              TEXT,
  category              TEXT    CHECK(category IN ('deep_work','shallow_work','communication','consumption','distraction','idle')),
  content_type          TEXT,
  attention_quality     TEXT    CHECK(attention_quality IN ('focused','browsing','consuming','distracted','idle')),
  specific_content      TEXT,
  productive_for_goals  INTEGER DEFAULT 0,
  confidence            REAL    DEFAULT 0.8,
  session_id            TEXT    REFERENCES guardian_sessions(session_id),
  raw_description       TEXT,
  -- New in 027
  task_alignment        REAL,
  engagement_depth      TEXT,
  distraction_indicators TEXT,
  progress_indicator    TEXT,
  change_magnitude      TEXT
);

INSERT INTO screen_observations_v027
  (id, observed_at, source, app, window_title, activity, category,
   content_type, attention_quality, specific_content, productive_for_goals,
   confidence, session_id, raw_description)
SELECT
   id, observed_at, source, app, window_title, activity, category,
   content_type, attention_quality, specific_content, productive_for_goals,
   confidence, session_id, raw_description
FROM screen_observations;

DROP TABLE screen_observations;
ALTER TABLE screen_observations_v027 RENAME TO screen_observations;

CREATE INDEX IF NOT EXISTS idx_screen_obs_observed_at ON screen_observations(observed_at DESC);
CREATE INDEX IF NOT EXISTS idx_screen_obs_session     ON screen_observations(session_id, observed_at DESC);
