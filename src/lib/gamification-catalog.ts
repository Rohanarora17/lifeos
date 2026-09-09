import type Database from 'better-sqlite3';

export function reseedGamificationCatalog(db: Database.Database): { badges: number; rewards: number } {
  const badgeResult = db.prepare(`
    INSERT OR IGNORE INTO badges (id, name, description, icon, metric, target) VALUES
      (1, 'First Steps', 'Complete your first task', '👶', 'tasks_done', 1),
      (2, 'Task Warrior', 'Complete 50 tasks', '⚔️', 'tasks_done', 50),
      (3, 'Executioner', 'Complete 500 tasks', '🥷', 'tasks_done', 500),
      (4, 'Getting Consistent', 'Reach a 7-day habit streak', '🔥', 'streak_days', 7),
      (5, 'Unbreakable', 'Reach a 30-day habit streak', '💎', 'streak_days', 30),
      (6, 'Deep Worker', 'Complete 10 Pomodoro sessions', '🧠', 'focus_sessions', 10),
      (7, 'Monk Mode', 'Complete 100 Pomodoro sessions', '🧘', 'focus_sessions', 100)
  `).run();

  const rewardResult = db.prepare(`
    INSERT OR IGNORE INTO rewards_store (
      id, title, cost, icon, category, pricing_json, adaptive_reason,
      user_cost_override, is_custom
    ) VALUES
      (1, '1 Hour Guilt-Free Gaming', 1000, '🎮', 'leisure', '{}', NULL, 0, 0),
      (2, 'Watch a Movie', 1500, '🍿', 'leisure', '{}', NULL, 0, 0),
      (3, 'Buy a Coffee out', 500, '☕', 'purchase', '{}', NULL, 0, 0),
      (4, 'Skip a Chore', 2000, '🧹', 'escape', '{}', NULL, 0, 0)
  `).run();

  return {
    badges: badgeResult.changes,
    rewards: rewardResult.changes,
  };
}
