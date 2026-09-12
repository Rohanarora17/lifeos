-- Durable per-attempt AI usage and estimated cost ledger.
-- Prices are snapshots used for local estimates; the cloud invoice remains authoritative.

CREATE TABLE IF NOT EXISTS ai_usage_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id TEXT NOT NULL UNIQUE,
  provider TEXT NOT NULL DEFAULT 'vertex_ai',
  project_id TEXT,
  location TEXT,
  requested_model TEXT NOT NULL,
  actual_model TEXT NOT NULL,
  operation TEXT NOT NULL CHECK(operation IN ('generate', 'stream')),
  feature TEXT NOT NULL DEFAULT 'unknown',
  status TEXT NOT NULL CHECK(status IN ('success', 'failed', 'cancelled')),
  attempt INTEGER NOT NULL DEFAULT 1,
  used_fallback INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  cached_input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  reasoning_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  estimated_cost_usd REAL NOT NULL DEFAULT 0,
  pricing_version TEXT NOT NULL,
  latency_ms INTEGER NOT NULL DEFAULT 0,
  error_code TEXT,
  error_message TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  started_at TEXT NOT NULL,
  completed_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ai_usage_events_completed
  ON ai_usage_events(completed_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_usage_events_model
  ON ai_usage_events(actual_model, completed_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_usage_events_feature
  ON ai_usage_events(feature, completed_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_usage_events_status
  ON ai_usage_events(status, completed_at DESC);
