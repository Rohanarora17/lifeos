-- Guardian Evidence V2 stores time-bounded collector facts first, then derives
-- one deterministic five-second activity slice. Existing Guardian history is
-- intentionally left in session_activity_intervals.

CREATE TABLE IF NOT EXISTS guardian_evidence_events (
  event_id             TEXT PRIMARY KEY,
  schema_version       INTEGER NOT NULL CHECK(schema_version = 2),
  sequence_number      INTEGER NOT NULL CHECK(sequence_number >= 0),
  collector            TEXT NOT NULL CHECK(collector IN ('native','chrome')),
  collector_version    TEXT NOT NULL,
  device_id            TEXT NOT NULL,
  session_id           TEXT NOT NULL REFERENCES guardian_sessions(session_id) ON DELETE CASCADE,
  observed_start       TEXT NOT NULL,
  observed_end         TEXT NOT NULL,
  duration_seconds     REAL NOT NULL CHECK(duration_seconds > 0),
  privacy_decision     TEXT NOT NULL CHECK(privacy_decision IN ('allow','redact','drop')),
  privacy_reason       TEXT NOT NULL,
  compatible           INTEGER NOT NULL DEFAULT 1,
  capabilities_json    TEXT NOT NULL DEFAULT '[]',
  payload_json         TEXT NOT NULL DEFAULT '{}',
  received_at          TEXT NOT NULL DEFAULT (datetime('now')),
  late_after_watermark INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_guardian_evidence_session_time
  ON guardian_evidence_events(session_id, observed_start, observed_end);
CREATE INDEX IF NOT EXISTS idx_guardian_evidence_collector_time
  ON guardian_evidence_events(collector, device_id, observed_end DESC);

CREATE TABLE IF NOT EXISTS guardian_activity_slices (
  slice_id              TEXT PRIMARY KEY,
  session_id            TEXT NOT NULL REFERENCES guardian_sessions(session_id) ON DELETE CASCADE,
  slice_bucket           TEXT NOT NULL,
  slice_start           TEXT NOT NULL,
  slice_end             TEXT NOT NULL,
  duration_seconds      REAL NOT NULL CHECK(duration_seconds > 0 AND duration_seconds <= 5),
  source                TEXT NOT NULL CHECK(source IN ('chrome','vision','idle','private','unverified')),
  state                 TEXT NOT NULL CHECK(state IN ('active','locked','private','unverified')),
  app                   TEXT,
  window_title          TEXT,
  url                   TEXT,
  domain                TEXT,
  title                 TEXT,
  category              TEXT NOT NULL DEFAULT 'neutral'
                         CHECK(category IN ('productive','neutral','distraction')),
  subcategory           TEXT,
  engagement_state      TEXT NOT NULL
                         CHECK(engagement_state IN (
                           'interactive','passive_engaged','uncertain','confirmed_active',
                           'inactive','private','disconnected'
                         )),
  engagement_confidence REAL,
  score_eligible        INTEGER NOT NULL DEFAULT 0,
  counted               INTEGER NOT NULL DEFAULT 0,
  selection_reason      TEXT NOT NULL,
  evidence_ids_json     TEXT NOT NULL DEFAULT '[]',
  provisional           INTEGER NOT NULL DEFAULT 1,
  finalized_at          TEXT,
  canonical_revision    INTEGER NOT NULL DEFAULT 1,
  pipeline_mode         TEXT NOT NULL CHECK(pipeline_mode IN ('shadow','authoritative')),
  created_at            TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at            TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(session_id, slice_bucket)
);

CREATE INDEX IF NOT EXISTS idx_guardian_slices_session_time
  ON guardian_activity_slices(session_id, slice_start);
CREATE INDEX IF NOT EXISTS idx_guardian_slices_scoring
  ON guardian_activity_slices(session_id, pipeline_mode, provisional, counted, score_eligible);

CREATE TABLE IF NOT EXISTS guardian_score_snapshots (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id            TEXT NOT NULL REFERENCES guardian_sessions(session_id) ON DELETE CASCADE,
  score                 REAL,
  canonical_revision    INTEGER NOT NULL,
  evidence_watermark    TEXT NOT NULL,
  eligible_seconds      REAL NOT NULL DEFAULT 0,
  covered_seconds       REAL NOT NULL DEFAULT 0,
  unverified_seconds    REAL NOT NULL DEFAULT 0,
  components_json       TEXT NOT NULL DEFAULT '{}',
  created_at            TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_guardian_score_snapshots_session
  ON guardian_score_snapshots(session_id, created_at DESC);

CREATE TABLE IF NOT EXISTS guardian_shadow_reports (
  session_id                TEXT PRIMARY KEY REFERENCES guardian_sessions(session_id) ON DELETE CASCADE,
  legacy_score              REAL,
  shadow_score              REAL,
  score_difference          REAL,
  legacy_seconds            REAL NOT NULL DEFAULT 0,
  canonical_seconds         REAL NOT NULL DEFAULT 0,
  eligible_seconds          REAL NOT NULL DEFAULT 0,
  unverified_seconds        REAL NOT NULL DEFAULT 0,
  overlap_violations        INTEGER NOT NULL DEFAULT 0,
  source_mismatches         INTEGER NOT NULL DEFAULT 0,
  late_evidence_count       INTEGER NOT NULL DEFAULT 0,
  incompatible_event_count  INTEGER NOT NULL DEFAULT 0,
  source_totals_json        TEXT NOT NULL DEFAULT '{}',
  accepted                  INTEGER NOT NULL DEFAULT 0,
  recorded_at               TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_guardian_shadow_reports_acceptance
  ON guardian_shadow_reports(accepted, recorded_at DESC);

ALTER TABLE guardian_sessions ADD COLUMN evidence_pipeline_mode TEXT NOT NULL DEFAULT 'legacy'
  CHECK(evidence_pipeline_mode IN ('legacy','shadow','authoritative'));

DROP VIEW IF EXISTS guardian_activity_segments;
CREATE VIEW guardian_activity_segments AS
WITH ordered AS (
  SELECT s.*,
    CASE WHEN
      LAG(slice_end) OVER (PARTITION BY session_id ORDER BY slice_start) = slice_start
      AND LAG(source) OVER (PARTITION BY session_id ORDER BY slice_start) = source
      AND COALESCE(LAG(app) OVER (PARTITION BY session_id ORDER BY slice_start), '') = COALESCE(app, '')
      AND COALESCE(LAG(domain) OVER (PARTITION BY session_id ORDER BY slice_start), '') = COALESCE(domain, '')
      AND LAG(category) OVER (PARTITION BY session_id ORDER BY slice_start) = category
      AND LAG(engagement_state) OVER (PARTITION BY session_id ORDER BY slice_start) = engagement_state
      AND LAG(score_eligible) OVER (PARTITION BY session_id ORDER BY slice_start) = score_eligible
      AND LAG(provisional) OVER (PARTITION BY session_id ORDER BY slice_start) = provisional
    THEN 0 ELSE 1 END AS starts_segment
  FROM guardian_activity_slices s
), grouped AS (
  SELECT ordered.*,
    SUM(starts_segment) OVER (
      PARTITION BY session_id ORDER BY slice_start ROWS UNBOUNDED PRECEDING
    ) AS segment_number
  FROM ordered
)
SELECT
  session_id || ':' || segment_number AS segment_id,
  session_id,
  MIN(slice_start) AS observed_start,
  MAX(slice_end) AS observed_end,
  SUM(duration_seconds) AS duration_seconds,
  source, state, app,
  MAX(window_title) AS window_title,
  MAX(url) AS url,
  domain,
  MAX(title) AS title,
  category,
  MAX(subcategory) AS subcategory,
  engagement_state,
  AVG(engagement_confidence) AS engagement_confidence,
  score_eligible,
  MIN(counted) AS counted,
  MAX(selection_reason) AS selection_reason,
  MAX(provisional) AS provisional,
  MAX(canonical_revision) AS canonical_revision,
  pipeline_mode,
  json_group_array(evidence_ids_json) AS evidence_ids_json
FROM grouped
GROUP BY session_id, segment_number, source, state, app, domain, category,
         engagement_state, score_eligible, pipeline_mode;

DROP VIEW IF EXISTS effective_activities;
CREATE VIEW effective_activities AS
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
  NULL, COALESCE(url, 'native://' || COALESCE(app, 'activity')),
  COALESCE(domain, app, 'macOS'), COALESCE(title, window_title, app, 'Verified activity'),
  category, COALESCE(subcategory, state), observed_start, observed_end,
  duration_seconds, evidence_json, NULL, NULL, created_at,
  CASE source WHEN 'chrome' THEN 'Chrome extension' ELSE 'MacBook vision client' END,
  score_eligible, -1, NULL, NULL, session_id, counted, source, selection_reason
FROM session_activity_intervals sai
WHERE counted = 1 AND score_eligible = 1
  AND NOT EXISTS (
    SELECT 1 FROM guardian_sessions gs
    WHERE gs.session_id = sai.session_id AND gs.evidence_pipeline_mode = 'authoritative'
  )
UNION ALL
SELECT
  NULL, COALESCE(url, 'native://' || COALESCE(app, 'activity')),
  COALESCE(domain, app, 'macOS'), COALESCE(title, window_title, app, 'Verified activity'),
  category, COALESCE(subcategory, state), observed_start, observed_end,
  duration_seconds, json_object('evidence_ids', evidence_ids_json), NULL, NULL,
  datetime(observed_start),
  CASE source WHEN 'chrome' THEN 'Chrome extension' ELSE 'MacBook vision client' END,
  score_eligible, -1, NULL, NULL, session_id, counted, source, selection_reason
FROM guardian_activity_segments
WHERE pipeline_mode = 'authoritative' AND provisional = 0 AND counted = 1 AND score_eligible = 1;
