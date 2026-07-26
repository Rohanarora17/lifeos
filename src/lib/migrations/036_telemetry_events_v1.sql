CREATE TABLE IF NOT EXISTS telemetry_events_v1 (
  event_id           TEXT PRIMARY KEY,
  version            INTEGER NOT NULL CHECK(version = 1),
  device_id          TEXT NOT NULL,
  source             TEXT NOT NULL CHECK(source IN (
    'browser_extension',
    'native_macos',
    'legacy_adapter'
  )),
  observed_start     TEXT NOT NULL,
  observed_end       TEXT NOT NULL,
  duration_seconds   INTEGER NOT NULL CHECK(duration_seconds >= 0),
  state              TEXT NOT NULL CHECK(state IN (
    'active',
    'idle',
    'locked',
    'unfocused'
  )),
  session_id         TEXT,
  context_json       TEXT,
  provenance_json    TEXT NOT NULL,
  privacy_decision   TEXT NOT NULL CHECK(privacy_decision IN (
    'allow',
    'redact',
    'drop'
  )),
  privacy_reason     TEXT NOT NULL,
  ingested_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_telemetry_v1_device_time
  ON telemetry_events_v1(device_id, observed_start DESC);

CREATE INDEX IF NOT EXISTS idx_telemetry_v1_session_time
  ON telemetry_events_v1(session_id, observed_start DESC);

CREATE INDEX IF NOT EXISTS idx_telemetry_v1_state_time
  ON telemetry_events_v1(state, observed_start DESC);
