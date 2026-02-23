-- Add daily sub-scores for tasks and habits to daily_scores
ALTER TABLE daily_scores ADD COLUMN task_score INTEGER DEFAULT 0;
ALTER TABLE daily_scores ADD COLUMN habit_score INTEGER DEFAULT 0;
ALTER TABLE daily_scores ADD COLUMN tasks_assigned INTEGER DEFAULT 0;
ALTER TABLE daily_scores ADD COLUMN tasks_pending INTEGER DEFAULT 0;
