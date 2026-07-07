-- Migration 029: Notification feedback loop
--
-- Alerts are agent actions too. Link each alert to agent_action_outcomes so
-- notification helpfulness can tune future intervention strength.

ALTER TABLE alerts ADD COLUMN outcome_id INTEGER REFERENCES agent_action_outcomes(id);
ALTER TABLE alerts ADD COLUMN feedback TEXT CHECK(feedback IN ('helpful','not_helpful','dismissed'));
ALTER TABLE alerts ADD COLUMN feedback_reason TEXT;
ALTER TABLE alerts ADD COLUMN feedback_at TEXT;
ALTER TABLE alerts ADD COLUMN adaptive_reason TEXT;

CREATE INDEX IF NOT EXISTS idx_alerts_outcome ON alerts(outcome_id);
CREATE INDEX IF NOT EXISTS idx_alerts_feedback ON alerts(feedback, feedback_at DESC);
