import { getDb } from './db';
import { getAutomaticityScore, getStreakCount } from './scoring';
import { buildPersonalizationSnapshot } from './personalization-context';
import { buildAdaptiveHabitPlans, type AdaptiveHabitInput } from './adaptive-habit-plan';

export type HabitCheckinSource = 'manual' | 'screen_time' | 'guardian_session' | 'chat' | 'voice' | 'telegram' | 'photo_proof';

export interface AdaptiveHabitCheckinResult {
  habitId: number;
  habitName: string;
  goalMetric: 'boolean' | 'time';
  value: number;
  completed: boolean;
  alreadyCompleted: boolean;
  adaptiveTarget: number;
  adaptiveReason: string | null;
  adaptiveIntensity: string | null;
}

function getTodayIst(): string {
  return new Date(Date.now() + 19_800_000).toISOString().slice(0, 10);
}

export function recordAdaptiveHabitCheckin(input: {
  habitId: number;
  date?: string | null;
  source: HabitCheckinSource;
  value?: number | null;
  forceComplete?: boolean;
}): AdaptiveHabitCheckinResult {
  const db = getDb();
  const checkinDate = input.date || getTodayIst();
  const habit = db.prepare(`
    SELECT h.id, h.name, h.icon, h.goal_metric, h.goal_target,
           CASE WHEN hc.id IS NOT NULL THEN hc.completed ELSE 0 END as checked_today,
           COALESCE(hc.value, 0) as today_value,
           g.title as goal_title,
           (SELECT COUNT(*) FROM habit_checkins WHERE habit_id = h.id AND completed = 1) as total_checkins
    FROM habits h
    LEFT JOIN goals g ON g.id = h.goal_id
    LEFT JOIN habit_checkins hc ON hc.habit_id = h.id AND hc.date = ?
    WHERE h.id = ? AND h.archived = 0
  `).get(checkinDate, input.habitId) as AdaptiveHabitInput | undefined;

  if (!habit) throw new Error('Habit not found');

  const checkins = db.prepare('SELECT date FROM habit_checkins WHERE habit_id = ? AND completed = 1 ORDER BY date DESC').all(habit.id) as { date: string }[];
  habit.current_streak = getStreakCount(checkins.map(c => c.date));
  habit.automaticity_score = getAutomaticityScore(habit.current_streak);

  const snapshot = buildPersonalizationSnapshot({
    surface: 'habits',
    maxInsights: 2,
    includeMemoryFacts: 4,
  });
  const plan = buildAdaptiveHabitPlans([habit], snapshot).get(habit.id);
  const adaptiveTarget = plan?.adaptive_today_target ?? habit.goal_target ?? 1;
  const existing = db.prepare(
    'SELECT id, completed, value FROM habit_checkins WHERE habit_id = ? AND date = ?'
  ).get(habit.id, checkinDate) as { id: number; completed: number; value: number | null } | undefined;
  const alreadyCompleted = !!existing?.completed;

  const requestedValue = Number(input.value);
  const baseValue = Number.isFinite(requestedValue) && requestedValue > 0
    ? Math.round(requestedValue)
    : habit.goal_metric === 'time' && input.forceComplete !== false
      ? adaptiveTarget
      : 1;
  const finalValue = Math.max(Number(existing?.value ?? 0), baseValue);
  const completed = habit.goal_metric === 'time'
    ? finalValue >= adaptiveTarget
    : input.forceComplete !== false;

  db.prepare(`
    INSERT INTO habit_checkins (habit_id, date, completed, value, source)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(habit_id, date) DO UPDATE SET
      completed = excluded.completed,
      value = MAX(COALESCE(value, 0), excluded.value),
      source = excluded.source
  `).run(habit.id, checkinDate, completed ? 1 : 0, finalValue, input.source);

  return {
    habitId: habit.id,
    habitName: habit.name,
    goalMetric: habit.goal_metric,
    value: finalValue,
    completed,
    alreadyCompleted,
    adaptiveTarget,
    adaptiveReason: plan?.adaptive_reason ?? null,
    adaptiveIntensity: plan?.adaptive_intensity ?? null,
  };
}
