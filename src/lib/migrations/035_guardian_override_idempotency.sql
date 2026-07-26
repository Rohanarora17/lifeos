ALTER TABLE guardian_override_requests ADD COLUMN idempotency_key TEXT DEFAULT NULL;
ALTER TABLE guardian_override_requests ADD COLUMN decision_json TEXT DEFAULT NULL;
ALTER TABLE guardian_override_requests ADD COLUMN outcome_id INTEGER REFERENCES agent_action_outcomes(id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_guardian_override_idempotency
  ON guardian_override_requests(idempotency_key)
  WHERE idempotency_key IS NOT NULL;
