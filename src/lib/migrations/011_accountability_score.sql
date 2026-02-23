-- Add computed accountability_score column to daily_scores
-- This pre-computes the Accountability Score so the dashboard doesn't compute it every request.
-- Score = (focus_ratio * 40) + (task_completion * 30) + (habit_completion * 30), 0-100.
ALTER TABLE daily_scores ADD COLUMN accountability_score INTEGER DEFAULT 0;
