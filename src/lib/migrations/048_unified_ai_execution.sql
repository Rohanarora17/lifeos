-- Attribute every AI attempt to a logical LifeOS operation and execution policy.
ALTER TABLE ai_usage_events ADD COLUMN logical_request_id TEXT;
ALTER TABLE ai_usage_events ADD COLUMN work_class TEXT;
ALTER TABLE ai_usage_events ADD COLUMN quality_tier TEXT;
ALTER TABLE ai_usage_events ADD COLUMN trigger TEXT;
ALTER TABLE ai_usage_events ADD COLUMN entity_id TEXT;
ALTER TABLE ai_usage_events ADD COLUMN request_fingerprint TEXT;

UPDATE ai_usage_events
SET logical_request_id = CASE
  WHEN instr(request_id, ':') > 0 THEN substr(request_id, 1, instr(request_id, ':') - 1)
  ELSE request_id
END
WHERE logical_request_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_ai_usage_events_logical_request
  ON ai_usage_events(logical_request_id, completed_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_usage_events_work_class
  ON ai_usage_events(work_class, completed_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_usage_events_quality
  ON ai_usage_events(quality_tier, completed_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_usage_events_fingerprint
  ON ai_usage_events(feature, request_fingerprint, completed_at DESC);
