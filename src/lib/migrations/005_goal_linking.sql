-- Phase 10: Goal-Task-Habit Integration

-- Add goal linking to tasks
ALTER TABLE tasks ADD COLUMN goal_id INTEGER DEFAULT NULL REFERENCES goals(id);

-- Add goal linking to habits
ALTER TABLE habits ADD COLUMN goal_id INTEGER DEFAULT NULL REFERENCES goals(id);

-- Enrich goals with deadline, progress tracking, and description
ALTER TABLE goals ADD COLUMN deadline TEXT DEFAULT NULL;
ALTER TABLE goals ADD COLUMN description TEXT DEFAULT '';
ALTER TABLE goals ADD COLUMN current_value REAL DEFAULT 0;
ALTER TABLE goals ADD COLUMN progress REAL DEFAULT 0;
ALTER TABLE goals ADD COLUMN metric TEXT DEFAULT 'tasks';
ALTER TABLE goals ADD COLUMN category TEXT DEFAULT 'productivity';

-- Indexes for goal lookups
CREATE INDEX IF NOT EXISTS idx_tasks_goal ON tasks(goal_id);
CREATE INDEX IF NOT EXISTS idx_habits_goal ON habits(goal_id);
