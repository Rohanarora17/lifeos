-- 016: Update tasks status CHECK constraint to match student architecture
-- Adds 'todo' and removes old kanban states (backlog/next/this_week/today)
-- Also adds new student metadata columns in one shot.
-- SQLite requires a full table rebuild to change CHECK constraints.

PRAGMA foreign_keys = OFF;

CREATE TABLE tasks_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  description TEXT DEFAULT '',
  status TEXT DEFAULT 'todo' CHECK(status IN ('todo','doing','done')),
  due_date TEXT,
  due_time TEXT DEFAULT NULL,
  task_type TEXT DEFAULT 'task',
  course TEXT DEFAULT NULL,
  priority_rank INTEGER DEFAULT NULL,
  priority_reason TEXT DEFAULT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  completed_at TEXT,
  position INTEGER DEFAULT 0,
  goal_id INTEGER DEFAULT NULL REFERENCES goals(id),
  priority TEXT DEFAULT 'medium',
  energy_required TEXT DEFAULT 'medium',
  complexity TEXT DEFAULT 'familiar',
  estimated_minutes INTEGER DEFAULT NULL,
  blocked_since TEXT DEFAULT NULL,
  subtask_of INTEGER REFERENCES tasks_new(id)
);

-- Copy existing rows, collapsing old statuses → todo
INSERT INTO tasks_new (
  id, title, description, status, due_date, due_time, task_type, course,
  priority_rank, priority_reason,
  created_at, completed_at, position, goal_id, priority,
  energy_required, complexity, estimated_minutes, blocked_since, subtask_of
)
SELECT
  id, title, description,
  CASE
    WHEN status IN ('backlog','next','this_week','today') THEN 'todo'
    WHEN status = 'doing' THEN 'doing'
    WHEN status = 'done'  THEN 'done'
    ELSE 'todo'
  END,
  due_date,
  NULL,   -- due_time (new column)
  'task', -- task_type (new column)
  NULL,   -- course (new column)
  NULL,   -- priority_rank (new column)
  NULL,   -- priority_reason (new column)
  created_at, completed_at, position, goal_id, priority,
  energy_required, complexity, estimated_minutes, blocked_since, subtask_of
FROM tasks;

DROP TABLE tasks;
ALTER TABLE tasks_new RENAME TO tasks;

CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_goal ON tasks(goal_id);
CREATE INDEX IF NOT EXISTS idx_tasks_priority_rank ON tasks(priority_rank);

PRAGMA foreign_keys = ON;
