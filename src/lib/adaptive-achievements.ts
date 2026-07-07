import type { PersonalizationSnapshot } from './personalization-context';

export interface AchievementStats {
  tasks_done: number;
  focus_sessions: number;
  streak_days: number;
}

export interface BadgeProgressInput {
  id: number;
  name: string;
  description: string;
  icon: string;
  metric: keyof AchievementStats | string;
  target: number;
  unlocked_at: string | null;
}

export interface AdaptiveBadgeProgress {
  adaptive_current_value: number;
  adaptive_unlock_target: number;
  adaptive_progress: number;
  adaptive_canonical_progress: number;
  adaptive_remaining: number;
  adaptive_unlock_ready: boolean;
  adaptive_reason: string;
  adaptive_next_step: string;
  adaptive_moment_fit: 'high' | 'medium' | 'low';
}

function metricLabel(metric: string): string {
  if (metric === 'tasks_done') return 'completed task';
  if (metric === 'focus_sessions') return 'focus session';
  if (metric === 'streak_days') return 'streak day';
  return 'progress unit';
}

function nextStepFor(metric: string, snapshot: PersonalizationSnapshot): string {
  const unit = metricLabel(metric);

  if (snapshot.moment.mode === 'recovery') {
    return `Aim for one low-friction ${unit}; protecting energy matters more than forcing a streak.`;
  }
  if (snapshot.moment.mode === 'deadline_pressure') {
    return metric === 'tasks_done'
      ? 'Use deadline-relief tasks for badge progress today.'
      : 'Do badge progress only if it supports the deadline.';
  }
  if (snapshot.moment.mode === 'protect_focus') {
    return 'Do not chase the badge mid-flow; let the current focus block count naturally.';
  }
  if (snapshot.moment.mode === 'planning') {
    return `Pick the smallest ${unit} that sets up tomorrow.`;
  }
  return `One meaningful ${unit} is enough progress for this pass.`;
}

function reasonFor(metric: string, snapshot: PersonalizationSnapshot): string {
  if (snapshot.moment.mode === 'recovery') {
    return 'Recovery mode: progress is framed around consistency, not intensity.';
  }
  if (snapshot.moment.mode === 'deadline_pressure') {
    return 'Deadline pressure: achievements should reinforce urgent work, not distract from it.';
  }
  if (snapshot.moment.mode === 'protect_focus') {
    return 'Focus is already active: keep achievement feedback quiet and non-interruptive.';
  }
  if (snapshot.moment.mode === 'planning') {
    return 'Planning mode: badge progress is useful when it clarifies the next small step.';
  }
  return `${metricLabel(metric)} progress is balanced against today's energy and workload.`;
}

function targetMultiplier(metric: string, snapshot: PersonalizationSnapshot): number {
  const mode = snapshot.moment.mode;
  let multiplier = 1;

  if (mode === 'recovery') {
    multiplier *= metric === 'streak_days' ? 0.9 : 0.8;
  } else if (mode === 'deadline_pressure') {
    multiplier *= metric === 'tasks_done' ? 0.85 : 0.95;
  } else if (mode === 'protect_focus') {
    multiplier *= metric === 'focus_sessions' ? 0.9 : 1;
  } else if (mode === 'planning') {
    multiplier *= 0.95;
  }

  if (snapshot.userState.energy === 'low') multiplier *= 0.95;
  if (snapshot.userState.focusTrend === 'declining') multiplier *= 0.95;
  if (snapshot.feedback.alertFatigueLevel === 'high') multiplier *= 0.95;

  return Math.max(0.65, Math.min(1, multiplier));
}

export function getAdaptiveBadgeTarget(
  badge: Pick<BadgeProgressInput, 'metric' | 'target'>,
  snapshot: PersonalizationSnapshot,
): number {
  const target = Math.max(1, Math.round(badge.target || 1));
  if (target <= 3) return target;

  const adjusted = Math.round(target * targetMultiplier(String(badge.metric), snapshot));
  return Math.max(1, Math.min(target, adjusted));
}

function unlockReasonFor(
  badge: Pick<BadgeProgressInput, 'metric' | 'target'>,
  adaptiveTarget: number,
  snapshot: PersonalizationSnapshot,
): string {
  if (adaptiveTarget >= badge.target) return 'Unlocked at the badge target.';
  const saved = badge.target - adaptiveTarget;
  if (snapshot.moment.mode === 'recovery') {
    return `Unlocked ${saved} ${metricLabel(String(badge.metric))}${saved === 1 ? '' : 's'} early because recovery mode values consistency over intensity.`;
  }
  if (snapshot.moment.mode === 'deadline_pressure') {
    return `Unlocked ${saved} ${metricLabel(String(badge.metric))}${saved === 1 ? '' : 's'} early because today's progress should reinforce deadline relief.`;
  }
  if (snapshot.moment.mode === 'protect_focus') {
    return `Unlocked ${saved} ${metricLabel(String(badge.metric))}${saved === 1 ? '' : 's'} early because the current focus block is the useful signal.`;
  }
  return `Unlocked against today's adaptive target, ${saved} below the long-term badge target.`;
}

function momentFit(metric: string, snapshot: PersonalizationSnapshot): 'high' | 'medium' | 'low' {
  if (snapshot.moment.mode === 'deadline_pressure') return metric === 'tasks_done' ? 'high' : 'low';
  if (snapshot.moment.mode === 'protect_focus') return metric === 'focus_sessions' ? 'high' : 'medium';
  if (snapshot.moment.mode === 'recovery') return metric === 'streak_days' ? 'medium' : 'low';
  return 'medium';
}

export function buildAdaptiveBadgeProgress(
  badges: BadgeProgressInput[],
  stats: AchievementStats,
  snapshot: PersonalizationSnapshot,
): Array<BadgeProgressInput & AdaptiveBadgeProgress> {
  return badges.map(badge => {
    const current = stats[badge.metric as keyof AchievementStats] ?? 0;
    const adaptiveTarget = getAdaptiveBadgeTarget(badge, snapshot);
    const progress = adaptiveTarget > 0 ? Math.min(100, Math.round((current / adaptiveTarget) * 100)) : 0;
    const canonicalProgress = badge.target > 0 ? Math.min(100, Math.round((current / badge.target) * 100)) : 0;

    return {
      ...badge,
      adaptive_current_value: current,
      adaptive_unlock_target: adaptiveTarget,
      adaptive_progress: progress,
      adaptive_canonical_progress: canonicalProgress,
      adaptive_remaining: Math.max(0, adaptiveTarget - current),
      adaptive_unlock_ready: current >= adaptiveTarget,
      adaptive_reason: reasonFor(badge.metric, snapshot),
      adaptive_next_step: nextStepFor(badge.metric, snapshot),
      adaptive_moment_fit: momentFit(badge.metric, snapshot),
    };
  });
}

export function getAdaptiveBadgeUnlockDecision(
  badge: BadgeProgressInput,
  stats: AchievementStats,
  snapshot: PersonalizationSnapshot,
): BadgeProgressInput & AdaptiveBadgeProgress & { adaptive_unlock_reason: string } {
  const [progress] = buildAdaptiveBadgeProgress([badge], stats, snapshot);
  return {
    ...progress,
    adaptive_unlock_reason: unlockReasonFor(badge, progress.adaptive_unlock_target, snapshot),
  };
}
