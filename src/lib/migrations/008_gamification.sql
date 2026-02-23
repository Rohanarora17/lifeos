-- Phase 16: Reward Economy & Gamification

CREATE TABLE IF NOT EXISTS coin_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  amount INTEGER NOT NULL,
  reason TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS rewards_store (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  cost INTEGER NOT NULL,
  icon TEXT DEFAULT '🎁',
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS badges (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  icon TEXT NOT NULL,
  metric TEXT NOT NULL, -- e.g., 'tasks_done', 'streak_days', 'focus_sessions'
  target INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS user_badges (
  badge_id INTEGER PRIMARY KEY REFERENCES badges(id),
  unlocked_at TEXT DEFAULT (datetime('now'))
);

-- Seed some default badges
INSERT OR IGNORE INTO badges (id, name, description, icon, metric, target) VALUES 
  (1, 'First Steps', 'Complete your first task', '👶', 'tasks_done', 1),
  (2, 'Task Warrior', 'Complete 50 tasks', '⚔️', 'tasks_done', 50),
  (3, 'Executioner', 'Complete 500 tasks', '🥷', 'tasks_done', 500),
  (4, 'Getting Consistent', 'Reach a 7-day habit streak', '🔥', 'streak_days', 7),
  (5, 'Unbreakable', 'Reach a 30-day habit streak', '💎', 'streak_days', 30),
  (6, 'Deep Worker', 'Complete 10 Pomodoro sessions', '🧠', 'focus_sessions', 10),
  (7, 'Monk Mode', 'Complete 100 Pomodoro sessions', '🧘', 'focus_sessions', 100);

-- Seed some default store items
INSERT OR IGNORE INTO rewards_store (id, title, cost, icon) VALUES 
  (1, '1 Hour Guilt-Free Gaming', 1000, '🎮'),
  (2, 'Watch a Movie', 1500, '🍿'),
  (3, 'Buy a Coffee out', 500, '☕'),
  (4, 'Skip a Chore', 2000, '🧹');
