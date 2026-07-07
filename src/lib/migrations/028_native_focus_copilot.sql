-- Migration 028: native focus copilot integration
--
-- Native app data must flow into the same tables used by UIL, nudges, memory,
-- and guardian runtime. This expands source constraints and adds a small
-- feedback table that also mirrors into agent_action_outcomes.

CREATE TABLE screen_observations_v028 (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  observed_at           TEXT    NOT NULL,
  source                TEXT    NOT NULL DEFAULT 'screenshot'
                                CHECK(source IN ('screenshot','daemon','extension_screenshot','extension_daemon','screen_vision','native_copilot')),
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
  task_alignment        REAL,
  engagement_depth      TEXT,
  distraction_indicators TEXT,
  progress_indicator    TEXT,
  change_magnitude      TEXT
);

INSERT INTO screen_observations_v028
  (id, observed_at, source, app, window_title, activity, category,
   content_type, attention_quality, specific_content, productive_for_goals,
   confidence, session_id, raw_description, task_alignment, engagement_depth,
   distraction_indicators, progress_indicator, change_magnitude)
SELECT
   id, observed_at, source, app, window_title, activity, category,
   content_type, attention_quality, specific_content, productive_for_goals,
   confidence, session_id, raw_description, task_alignment, engagement_depth,
   distraction_indicators, progress_indicator, change_magnitude
FROM screen_observations;

DROP TABLE screen_observations;
ALTER TABLE screen_observations_v028 RENAME TO screen_observations;

CREATE INDEX IF NOT EXISTS idx_screen_obs_observed_at ON screen_observations(observed_at DESC);
CREATE INDEX IF NOT EXISTS idx_screen_obs_session     ON screen_observations(session_id, observed_at DESC);

CREATE TABLE mem_episodes_v028 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL CHECK(source IN ('guardian','voice','chat','browse','manual','native_copilot')),
  summary TEXT NOT NULL,
  raw_context TEXT,
  importance REAL DEFAULT 0.5,
  started_at TEXT,
  ended_at TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

INSERT INTO mem_episodes_v028
  (id, source, summary, raw_context, importance, started_at, ended_at, created_at)
SELECT id, source, summary, raw_context, importance, started_at, ended_at, created_at
FROM mem_episodes;

DROP TABLE mem_episodes;
ALTER TABLE mem_episodes_v028 RENAME TO mem_episodes;

CREATE INDEX IF NOT EXISTS idx_mem_ep_source ON mem_episodes(source, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_mem_ep_importance ON mem_episodes(importance DESC);

CREATE TABLE IF NOT EXISTS native_guidance_feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  outcome_id INTEGER REFERENCES agent_action_outcomes(id),
  session_id TEXT REFERENCES guardian_sessions(session_id),
  feedback TEXT NOT NULL CHECK(feedback IN ('helpful','not_helpful','dismissed','retry')),
  reason TEXT,
  metadata TEXT,
  created_at TEXT DEFAULT (datetime('now','localtime'))
);

CREATE INDEX IF NOT EXISTS idx_native_guidance_feedback_outcome ON native_guidance_feedback(outcome_id, created_at DESC);
