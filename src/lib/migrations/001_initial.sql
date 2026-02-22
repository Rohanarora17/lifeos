CREATE TABLE IF NOT EXISTS activities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  url TEXT NOT NULL,
  domain TEXT NOT NULL,
  title TEXT DEFAULT '',
  category TEXT DEFAULT 'neutral',
  subcategory TEXT DEFAULT 'other',
  started_at TEXT NOT NULL,
  ended_at TEXT,
  duration_seconds INTEGER DEFAULT 0,
  ai_classification TEXT,
  youtube_video_id TEXT,
  youtube_channel TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_activities_started ON activities(started_at);
CREATE INDEX IF NOT EXISTS idx_activities_domain ON activities(domain);
CREATE INDEX IF NOT EXISTS idx_activities_category ON activities(category);

CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  description TEXT DEFAULT '',
  status TEXT DEFAULT 'backlog' CHECK(status IN ('backlog','next','this_week','today','doing','done')),
  due_date TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  completed_at TEXT,
  position INTEGER DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);

CREATE TABLE IF NOT EXISTS habits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  icon TEXT DEFAULT '✅',
  frequency TEXT DEFAULT 'daily' CHECK(frequency IN ('daily','weekly')),
  goal_metric TEXT DEFAULT 'boolean' CHECK(goal_metric IN ('boolean', 'time')),
  goal_target INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now')),
  archived INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS habit_checkins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  habit_id INTEGER NOT NULL,
  date TEXT NOT NULL,
  completed INTEGER DEFAULT 1,
  value INTEGER DEFAULT 1,
  FOREIGN KEY (habit_id) REFERENCES habits(id) ON DELETE CASCADE,
  UNIQUE(habit_id, date)
);

CREATE TABLE IF NOT EXISTS daily_scores (
  date TEXT PRIMARY KEY,
  xp_earned INTEGER DEFAULT 0,
  productive_minutes INTEGER DEFAULT 0,
  distraction_minutes INTEGER DEFAULT 0,
  neutral_minutes INTEGER DEFAULT 0,
  tasks_completed INTEGER DEFAULT 0,
  habits_completed INTEGER DEFAULT 0,
  total_habits INTEGER DEFAULT 0,
  ai_summary TEXT,
  ai_morning_brief TEXT,
  level INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS calendar_events (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT DEFAULT '',
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  location TEXT DEFAULT '',
  synced_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS github_activity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL CHECK(type IN ('commit','pr','review','issue')),
  repo TEXT NOT NULL,
  message TEXT DEFAULT '',
  url TEXT DEFAULT '',
  created_at TEXT NOT NULL,
  synced_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_github_created ON github_activity(created_at);

CREATE TABLE IF NOT EXISTS nudge_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message TEXT NOT NULL,
  domain TEXT,
  duration_minutes INTEGER,
  acknowledged INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS tab_switches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  from_domain TEXT,
  to_domain TEXT,
  from_category TEXT,
  to_category TEXT,
  switched_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS screen_time (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  app_name TEXT NOT NULL,
  bundle_id TEXT NOT NULL,
  usage_seconds INTEGER DEFAULT 0,
  category TEXT DEFAULT 'neutral',
  date TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(bundle_id, date)
);
CREATE INDEX IF NOT EXISTS idx_screentime_date ON screen_time(date);

CREATE TABLE IF NOT EXISTS behavioral_memory (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  memory_type TEXT NOT NULL,
  content TEXT NOT NULL,
  confidence REAL DEFAULT 0.5,
  reinforcement_count INTEGER DEFAULT 1,
  last_reinforced TEXT DEFAULT (datetime('now')),
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(memory_type, content)
);

CREATE TABLE IF NOT EXISTS behavior_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  snapshot_date TEXT NOT NULL,
  type TEXT NOT NULL,
  data TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(snapshot_date, type)
);

CREATE TABLE IF NOT EXISTS goals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('build_feature', 'learn_skill', 'launch_project', 'general')),
  target_value INTEGER DEFAULT 1,
  unit TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  active INTEGER DEFAULT 1
);
