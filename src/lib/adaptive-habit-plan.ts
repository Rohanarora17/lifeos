import type { PersonalizationSnapshot } from './personalization-context';

export interface AdaptiveHabitInput {
  id: number;
  name: string;
  icon: string | null;
  goal_metric: 'boolean' | 'time';
  goal_target: number | null;
  checked_today: number;
  today_value: number;
  total_checkins: number;
  current_streak: number;
  automaticity_score: number;
  goal_title?: string | null;
}

export type HabitMomentFit = 'high' | 'medium' | 'low';
export type HabitIntensity = 'minimum' | 'normal' | 'stretch';

export interface AdaptiveHabitPlan {
  adaptive_priority_score: number;
  adaptive_rank: number;
  adaptive_reason: string;
  adaptive_today_target: number;
  adaptive_intensity: HabitIntensity;
  adaptive_moment_fit: HabitMomentFit;
  adaptive_goal_anchor: string | null;
}

export interface AdaptiveNewHabitDefaults {
  goalMetric: 'boolean' | 'time';
  timeTargetMinutes: number;
  intensity: HabitIntensity;
  reason: string;
}

function includesAny(text: string, needles: string[]): boolean {
  return needles.some(needle => text.includes(needle));
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function getAdaptiveTarget(habit: AdaptiveHabitInput, snapshot: PersonalizationSnapshot): {
  target: number;
  intensity: HabitIntensity;
  reason: string;
} {
  const baseTarget = Math.max(1, Number(habit.goal_target ?? 1));

  if (habit.goal_metric !== 'time') {
    if (snapshot.moment.mode === 'recovery' || snapshot.userState.energy === 'low') {
      return { target: 1, intensity: 'minimum', reason: 'minimum viable check-in' };
    }
    return { target: 1, intensity: 'normal', reason: 'simple completion' };
  }

  if (snapshot.moment.mode === 'recovery' || snapshot.userState.energy === 'low') {
    return {
      target: clamp(Math.round(baseTarget * 0.5), 5, baseTarget),
      intensity: 'minimum',
      reason: 'lower load for recovery',
    };
  }

  if (snapshot.moment.mode === 'deadline_pressure') {
    return {
      target: clamp(Math.round(baseTarget * 0.65), 10, baseTarget),
      intensity: 'minimum',
      reason: 'protect task deadline capacity',
    };
  }

  if (snapshot.moment.mode === 'planning' || snapshot.today.dayPhase === 'evening' || snapshot.today.dayPhase === 'night') {
    return {
      target: clamp(Math.round(baseTarget * 0.75), 5, baseTarget),
      intensity: 'normal',
      reason: 'evening maintenance dose',
    };
  }

  if (snapshot.userState.energy === 'high' && snapshot.userState.focusTrend === 'improving') {
    return {
      target: Math.round(baseTarget * 1.15),
      intensity: 'stretch',
      reason: 'good energy and improving focus',
    };
  }

  return { target: baseTarget, intensity: 'normal', reason: 'normal daily target' };
}

export function buildAdaptiveHabitPlans(
  habits: AdaptiveHabitInput[],
  snapshot: PersonalizationSnapshot,
): Map<number, AdaptiveHabitPlan> {
  const standup = (snapshot.userState.standupGoal ?? '').toLowerCase();
  const doing = snapshot.today.doingTasks.join(' ').toLowerCase();
  const deadlineMode = snapshot.moment.mode === 'deadline_pressure';
  const recoveryMode = snapshot.moment.mode === 'recovery';

  const scored = habits.map(habit => {
    let score = habit.checked_today ? 15 : 55;
    const reasons: string[] = [];
    const name = habit.name.toLowerCase();
    const goalTitle = (habit.goal_title ?? '').toLowerCase();
    const { target, intensity, reason: targetReason } = getAdaptiveTarget(habit, snapshot);

    if (!habit.checked_today) reasons.push('still open today');
    else reasons.push('already done');

    if (habit.current_streak > 0 && habit.current_streak < 7 && !habit.checked_today) {
      score += 10;
      reasons.push(`${habit.current_streak}d streak is still fragile`);
    } else if (habit.current_streak >= 7 && !habit.checked_today) {
      score += 6;
      reasons.push(`${habit.current_streak}d streak worth preserving`);
    }

    if (habit.automaticity_score < 40 && !habit.checked_today) {
      score += 8;
      reasons.push('not automatic yet');
    } else if (habit.automaticity_score > 80) {
      score -= recoveryMode ? 10 : 4;
      reasons.push('already highly automatic');
    }

    if (standup && (standup.includes(name) || goalTitle && standup.includes(goalTitle))) {
      score += 20;
      reasons.push('matches today\'s stated goal');
    } else if (standup && includesAny(`${name} ${goalTitle}`, standup.split(/\W+/).filter(word => word.length > 3))) {
      score += 12;
      reasons.push('near today\'s stated goal');
    }

    if (doing && includesAny(`${name} ${goalTitle}`, doing.split(/\W+/).filter(word => word.length > 3))) {
      score += 8;
      reasons.push('supports current work');
    }

    if (deadlineMode && habit.goal_metric === 'time') {
      score -= 8;
      reasons.push('trimmed because deadlines need capacity');
    }

    if (recoveryMode) {
      score += habit.goal_metric === 'boolean' ? 8 : -4;
      reasons.push(targetReason);
    } else if (targetReason !== 'normal daily target' && targetReason !== 'simple completion') {
      reasons.push(targetReason);
    }

    if (snapshot.feedback.alertFatigueLevel === 'high') {
      score -= habit.checked_today ? 0 : 6;
      reasons.push('keep reminders quiet');
    }

    const fit: HabitMomentFit = score >= 72 ? 'high' : score >= 48 ? 'medium' : 'low';

    return {
      habitId: habit.id,
      score: clamp(Math.round(score), 0, 100),
      fit,
      target,
      intensity,
      goalAnchor: habit.goal_title ?? null,
      reason: Array.from(new Set(reasons)).slice(0, 3).join(' · '),
    };
  }).sort((a, b) => b.score - a.score);

  return new Map(scored.map((item, index) => [item.habitId, {
    adaptive_priority_score: item.score,
    adaptive_rank: index + 1,
    adaptive_reason: item.reason,
    adaptive_today_target: item.target,
    adaptive_intensity: item.intensity,
    adaptive_moment_fit: item.fit,
    adaptive_goal_anchor: item.goalAnchor,
  }]));
}

export function buildAdaptiveNewHabitDefaults(snapshot: PersonalizationSnapshot): AdaptiveNewHabitDefaults {
  const lowEnergy = snapshot.moment.mode === 'recovery' || snapshot.userState.energy === 'low' || snapshot.userState.mood === 'low';
  const deadlinePressure = snapshot.moment.mode === 'deadline_pressure' || snapshot.today.overdueTasks > 0;
  const planningMode = snapshot.moment.mode === 'planning' || snapshot.today.dayPhase === 'evening' || snapshot.today.dayPhase === 'night';
  const strongFocus = snapshot.moment.mode === 'protect_focus' || (snapshot.userState.energy === 'high' && snapshot.userState.focusTrend === 'improving');

  if (lowEnergy) {
    return {
      goalMetric: 'boolean',
      timeTargetMinutes: 15,
      intensity: 'minimum',
      reason: 'low energy/recovery mode, so new habits should start as a small proof of consistency',
    };
  }

  if (deadlinePressure) {
    return {
      goalMetric: 'boolean',
      timeTargetMinutes: 20,
      intensity: 'minimum',
      reason: 'deadline pressure is active, so new habits should not steal execution capacity',
    };
  }

  if (planningMode) {
    return {
      goalMetric: 'boolean',
      timeTargetMinutes: 30,
      intensity: 'normal',
      reason: 'planning/evening mode favors a maintainable default that can be scheduled tomorrow',
    };
  }

  if (strongFocus) {
    return {
      goalMetric: 'time',
      timeTargetMinutes: 45,
      intensity: 'stretch',
      reason: 'current focus/energy can support a larger time-based habit target',
    };
  }

  return {
    goalMetric: 'boolean',
    timeTargetMinutes: 30,
    intensity: 'normal',
    reason: 'balanced mode favors a moderate target until the habit has evidence',
  };
}
