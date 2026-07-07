import { getDb } from './db';
import { getStreakCount } from './scoring';
import { buildPersonalizationSnapshot } from './personalization-context';
import { getAdaptiveRewardDecision } from './adaptive-rewards';
import { getAdaptiveBadgeUnlockDecision, type AchievementStats } from './adaptive-achievements';

interface BadgeRow {
  id: number;
  name: string;
  metric: keyof AchievementStats | string;
  target: number;
  icon: string;
  description: string;
}

interface CountRow {
  c: number;
}

interface HabitCheckinRow {
  habit_id: number;
  date: string;
}

export function getAchievementStats(): AchievementStats {
  const db = getDb();
  let tasksDone = 0;
  let focusSessions = 0;
  let maxStreak = 0;

  try { tasksDone = (db.prepare("SELECT COUNT(*) as c FROM tasks WHERE status = 'done'").get() as CountRow).c || 0; } catch (e) { console.error(e); }
  try { focusSessions = (db.prepare('SELECT COUNT(*) as c FROM guardian_session_summaries').get() as CountRow).c || 0; } catch (e) { console.error(e); }

  try {
    const allCheckins = db.prepare('SELECT habit_id, date FROM habit_checkins WHERE completed = 1').all() as HabitCheckinRow[];
    const habitsMap: Record<number, string[]> = {};
    for (const c of allCheckins) {
      if (!habitsMap[c.habit_id]) habitsMap[c.habit_id] = [];
      habitsMap[c.habit_id].push(c.date);
    }
    for (const dates of Object.values(habitsMap)) {
      const streak = getStreakCount(dates);
      if (streak > maxStreak) maxStreak = streak;
    }
  } catch (e) { console.error(e); }

  return {
    tasks_done: tasksDone,
    focus_sessions: focusSessions,
    streak_days: maxStreak,
  };
}

export function checkAchievements(): void {
  const db = getDb();

  const lockedBadges = db.prepare(`
        SELECT id, name, metric, target, icon, description
        FROM badges
        WHERE id NOT IN (SELECT badge_id FROM user_badges)
    `).all() as BadgeRow[];

  if (lockedBadges.length === 0) return;

  const stats = getAchievementStats();
  const rewardSnapshot = buildPersonalizationSnapshot({
    surface: 'achievements',
    maxInsights: 2,
    includeMemoryFacts: 3,
  });

  for (const badge of lockedBadges) {
    const decision = getAdaptiveBadgeUnlockDecision({
      ...badge,
      unlocked_at: null,
    }, stats, rewardSnapshot);
    if (!decision.adaptive_unlock_ready) continue;

    try {
      db.prepare('INSERT INTO user_badges (badge_id) VALUES (?)').run(badge.id);
      const reward = getAdaptiveRewardDecision({
        action: 'badge_unlock',
        baseCoins: 500,
        subject: `${badge.name} (${decision.adaptive_current_value}/${decision.adaptive_unlock_target})`,
        snapshot: rewardSnapshot,
      });
      db.prepare('INSERT INTO coin_ledger (amount, reason) VALUES (?, ?)').run(reward.coins, reward.ledgerReason);

      const priority = reward.mode === 'protect_focus' || reward.mode === 'deadline_pressure' ? 'medium' : 'high';
      db.prepare(`
          INSERT INTO alerts (title, message, type, priority)
          VALUES (?, ?, ?, ?)
        `).run(
        'Achievement unlocked',
        `You earned "${badge.name}" at ${decision.adaptive_current_value}/${decision.adaptive_unlock_target} ${badge.metric.replace('_', ' ')} and ${reward.label}. ${decision.adaptive_unlock_reason} ${reward.reason}`,
        'gamification',
        priority,
      );
    } catch (e) {
      console.error('Error unlocking badge:', e);
    }
  }
}
