-- Migration 030: Dashboard task recommendation feedback
--
-- Stores whether a recommended task actually fit the user's current moment.
-- This makes Daily Plan ranking learn from "good pick", "not now", and
-- follow-through signals instead of relying on static priority alone.

CREATE TABLE IF NOT EXISTS task_recommendation_feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  surface TEXT NOT NULL DEFAULT 'dashboard',
  moment_mode TEXT,
  feedback TEXT NOT NULL CHECK(feedback IN ('helpful','not_now','wrong','started','completed','dismissed')),
  reason TEXT,
  outcome_id INTEGER REFERENCES agent_action_outcomes(id),
  created_at TEXT DEFAULT (datetime('now','localtime'))
);

CREATE INDEX IF NOT EXISTS idx_task_reco_feedback_task ON task_recommendation_feedback(task_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_task_reco_feedback_signal ON task_recommendation_feedback(feedback, created_at DESC);
