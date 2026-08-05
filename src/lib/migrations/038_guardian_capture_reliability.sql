-- Persist collector readiness and a single authoritative activity timeline for
-- Guardian sessions. Raw browser/native evidence remains in its source tables;
-- only rows in session_activity_intervals are eligible for session scoring.

CREATE TABLE IF NOT EXISTS native_client_status (
  device_id                 TEXT PRIMARY KEY,
  client_version            TEXT NOT NULL DEFAULT 'unknown',
  last_seen_at              TEXT NOT NULL,
  screen_recording_status   TEXT NOT NULL DEFAULT 'unknown',
  capture_capable           INTEGER NOT NULL DEFAULT 0,
  frontmost_app             TEXT,
  frontmost_window_title    TEXT,
  system_state              TEXT NOT NULL DEFAULT 'active'
                            CHECK(system_state IN ('active','idle','locked')),
  active_session_id         TEXT,
  metadata_json             TEXT NOT NULL DEFAULT '{}',
  updated_at                TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_native_client_status_seen
  ON native_client_status(last_seen_at DESC);

CREATE TABLE IF NOT EXISTS browser_collector_status (
  device_id             TEXT PRIMARY KEY,
  last_seen_at          TEXT NOT NULL,
  session_id            TEXT,
  window_focused        INTEGER NOT NULL DEFAULT 0,
  collector_version     TEXT NOT NULL DEFAULT 'unknown',
  updated_at            TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_browser_collector_status_seen
  ON browser_collector_status(last_seen_at DESC);

CREATE TABLE IF NOT EXISTS session_activity_intervals (
  interval_id           TEXT PRIMARY KEY,
  session_id            TEXT NOT NULL REFERENCES guardian_sessions(session_id) ON DELETE CASCADE,
  device_id             TEXT NOT NULL,
  source                TEXT NOT NULL CHECK(source IN ('chrome','vision','idle','private')),
  observed_start        TEXT NOT NULL,
  observed_end          TEXT NOT NULL,
  duration_seconds      INTEGER NOT NULL CHECK(duration_seconds >= 0),
  state                 TEXT NOT NULL DEFAULT 'active' CHECK(state IN ('active','idle','locked','private')),
  app                   TEXT,
  window_title          TEXT,
  url                   TEXT,
  domain                TEXT,
  title                 TEXT,
  category              TEXT NOT NULL DEFAULT 'neutral' CHECK(category IN ('productive','neutral','distraction')),
  subcategory           TEXT,
  score_eligible        INTEGER NOT NULL DEFAULT 1,
  counted               INTEGER NOT NULL DEFAULT 1,
  selection_reason      TEXT NOT NULL,
  capture_status        TEXT NOT NULL DEFAULT 'verified',
  evidence_json         TEXT NOT NULL DEFAULT '{}',
  created_at            TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at            TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(session_id, source, observed_start, observed_end)
);

CREATE INDEX IF NOT EXISTS idx_session_activity_time
  ON session_activity_intervals(observed_start DESC);

CREATE INDEX IF NOT EXISTS idx_session_activity_session
  ON session_activity_intervals(session_id, observed_start ASC);

CREATE INDEX IF NOT EXISTS idx_session_activity_counted
  ON session_activity_intervals(counted, score_eligible, observed_start DESC);

ALTER TABLE guardian_sessions ADD COLUMN start_request_id TEXT;
ALTER TABLE guardian_sessions ADD COLUMN pause_reason TEXT;
ALTER TABLE guardian_sessions ADD COLUMN paused_at INTEGER;
ALTER TABLE guardian_sessions ADD COLUMN total_paused_ms INTEGER NOT NULL DEFAULT 0;

ALTER TABLE activities ADD COLUMN guardian_session_id TEXT;
ALTER TABLE activities ADD COLUMN counted INTEGER NOT NULL DEFAULT 1;
ALTER TABLE activities ADD COLUMN capture_source TEXT;
ALTER TABLE activities ADD COLUMN selection_reason TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_guardian_sessions_start_request
  ON guardian_sessions(start_request_id)
  WHERE start_request_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_activities_counted_time
  ON activities(counted, started_at DESC);

CREATE VIEW IF NOT EXISTS effective_activities AS
SELECT
  id, url, domain, title, category, subcategory, started_at, ended_at,
  duration_seconds, ai_classification, youtube_video_id, youtube_channel,
  created_at, device_name, is_actively_interacting, tab_group_id,
  tab_group_title, tab_group_color, guardian_session_id, counted, capture_source,
  selection_reason
FROM activities
WHERE counted = 1
UNION ALL
SELECT
  NULL AS id,
  COALESCE(url, 'native://' || COALESCE(app, 'activity')) AS url,
  COALESCE(domain, app, 'macOS') AS domain,
  COALESCE(title, window_title, app, 'Verified activity') AS title,
  category,
  COALESCE(subcategory, state) AS subcategory,
  observed_start AS started_at,
  observed_end AS ended_at,
  duration_seconds,
  evidence_json AS ai_classification,
  NULL AS youtube_video_id,
  NULL AS youtube_channel,
  created_at,
  CASE source WHEN 'chrome' THEN 'Chrome extension' ELSE 'MacBook vision client' END AS device_name,
  score_eligible AS is_actively_interacting,
  -1 AS tab_group_id,
  NULL AS tab_group_title,
  NULL AS tab_group_color,
  session_id AS guardian_session_id,
  counted,
  source AS capture_source,
  selection_reason
FROM session_activity_intervals
WHERE counted = 1 AND score_eligible = 1;
