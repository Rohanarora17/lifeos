import type { PersonalizationSnapshot } from './personalization-context';

export interface HabitHistoryInputDay {
  date: string;
  habits_completed: number;
  total_habits: number;
  habit_score?: number | null;
}

export interface AdaptiveHabitHistoryDay {
  adaptive_target_habits: number;
  adaptive_habit_score: number | null;
  adaptive_heatmap_level: number;
  adaptive_posture: 'minimum' | 'steady' | 'stretch' | 'learning';
  adaptive_reason: string;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function isoToday(): string {
  return new Date(Date.now() + 19_800_000).toISOString().slice(0, 10);
}

function recentBaseline(days: HabitHistoryInputDay[]): number {
  const meaningful = days
    .filter(day => day.total_habits > 0)
    .slice(-30);
  if (meaningful.length === 0) return 1;
  const averageCompleted = meaningful.reduce((sum, day) => sum + day.habits_completed, 0) / meaningful.length;
  return Math.max(1, Math.round(averageCompleted));
}

function targetForDay(day: HabitHistoryInputDay, baseline: number, snapshot: PersonalizationSnapshot): { target: number; reason: string } {
  const total = Math.max(0, day.total_habits);
  if (total === 0) return { target: 0, reason: 'no active habits that day' };

  let target = clamp(baseline, 1, total);
  const isToday = day.date === isoToday();
  const reasons = ['personal recent baseline'];

  if (isToday && (snapshot.moment.mode === 'recovery' || snapshot.userState.energy === 'low' || snapshot.userState.mood === 'low')) {
    target = clamp(Math.ceil(target * 0.7), 1, total);
    reasons.push('lowered for recovery/low energy today');
  } else if (isToday && snapshot.moment.mode === 'deadline_pressure') {
    target = clamp(Math.ceil(target * 0.8), 1, total);
    reasons.push('trimmed because deadline capacity matters today');
  } else if (isToday && snapshot.userState.energy === 'high' && snapshot.userState.focusTrend === 'improving') {
    target = clamp(Math.ceil(target * 1.15), 1, total);
    reasons.push('stretch allowed by current energy');
  }

  return { target, reason: reasons.join('; ') };
}

function levelFromScore(score: number | null): number {
  if (score === null) return 0;
  if (score >= 100) return 4;
  if (score >= 75) return 3;
  if (score >= 40) return 2;
  if (score > 0) return 1;
  return 0;
}

function posture(score: number | null, completed: number, target: number): AdaptiveHabitHistoryDay['adaptive_posture'] {
  if (target <= 0 || score === null) return 'learning';
  if (completed >= target && score >= 115) return 'stretch';
  if (completed >= target) return 'steady';
  if (completed > 0) return 'minimum';
  return 'learning';
}

export function buildAdaptiveHabitHistory(
  days: HabitHistoryInputDay[],
  snapshot: PersonalizationSnapshot,
): Array<HabitHistoryInputDay & AdaptiveHabitHistoryDay> {
  const baseline = recentBaseline(days);

  return days.map(day => {
    const { target, reason } = targetForDay(day, baseline, snapshot);
    const score = target > 0 ? Math.min(150, Math.round((day.habits_completed / target) * 100)) : null;

    return {
      ...day,
      adaptive_target_habits: target,
      adaptive_habit_score: score,
      adaptive_heatmap_level: levelFromScore(score),
      adaptive_posture: posture(score, day.habits_completed, target),
      adaptive_reason: target > 0
        ? `${day.habits_completed}/${target} habits against ${reason}`
        : reason,
    };
  });
}
