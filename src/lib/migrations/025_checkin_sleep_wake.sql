-- Migration 025: Add sleep/wake/intention tracking to daily_checkins

ALTER TABLE daily_checkins ADD COLUMN sleep_time TEXT;
ALTER TABLE daily_checkins ADD COLUMN wake_estimate TEXT;
ALTER TABLE daily_checkins ADD COLUMN tomorrow_intention TEXT;
ALTER TABLE daily_checkins ADD COLUMN inferred_goal_id INTEGER REFERENCES goals(id);
ALTER TABLE daily_checkins ADD COLUMN inferred_goal_confidence REAL;
