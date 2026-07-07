import type { PersonalizationSnapshot } from './personalization-context';

export interface AdaptiveGoalTask {
  id: number;
  title: string;
  status: string;
  completed_at: string | null;
}

export interface AdaptiveGoalHabit {
  id: number;
  name: string;
  icon: string;
  total_checkins: number;
  week_checkins: number;
}

export interface AdaptiveGoalInput {
  id: number;
  title: string;
  deadline: string | null;
  active: number;
  health_status: 'on_track' | 'at_risk' | 'off_track' | null;
  velocity_needed: number | null;
  actual_velocity: number | null;
  progress: number;
  taskProgress: number;
  habitHealth: number | null;
  linkedTasks: AdaptiveGoalTask[];
  linkedHabits: AdaptiveGoalHabit[];
  momentum: number | null;
}

export interface AdaptiveGoalPolicy {
  adaptiveGoalStatus: 'protect' | 'deadline_risk' | 'recovery_minimum' | 'stalled' | 'aligned' | 'stretch' | 'inactive';
  adaptiveProgressTarget: number;
  adaptiveProgressDelta: number;
  adaptiveProgressFit: 'high' | 'medium' | 'low';
  adaptiveGoalReason: string;
  adaptiveGoalCheckpoint: string;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function daysUntil(date: string | null): number | null {
  if (!date) return null;
  return Math.ceil((new Date(`${date}T23:59:59`).getTime() - Date.now()) / 86_400_000);
}

function textMatches(text: string | null | undefined, query: string | null | undefined): boolean {
  if (!text || !query) return false;
  const terms = query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(term => term.length >= 4);
  const lower = text.toLowerCase();
  return terms.length > 0 && terms.some(term => lower.includes(term));
}

function nextOpenTask(goal: AdaptiveGoalInput): AdaptiveGoalTask | null {
  return goal.linkedTasks.find(task => task.status !== 'done') ?? null;
}

function weakestHabit(goal: AdaptiveGoalInput): AdaptiveGoalHabit | null {
  return [...goal.linkedHabits].sort((a, b) => a.week_checkins - b.week_checkins)[0] ?? null;
}

function baseTarget(goal: AdaptiveGoalInput, snapshot: PersonalizationSnapshot): { target: number; reasons: string[] } {
  const reasons: string[] = [];
  let target = goal.progress;

  if (goal.health_status === 'off_track') {
    target += 12;
    reasons.push('off-track goal needs visible recovery');
  } else if (goal.health_status === 'at_risk') {
    target += 8;
    reasons.push('at-risk goal needs a concrete nudge');
  } else {
    target += 5;
    reasons.push('small daily movement is enough');
  }

  const days = daysUntil(goal.deadline);
  if (days !== null && days <= 1) {
    target += 14;
    reasons.push(days < 0 ? 'deadline is overdue' : 'deadline is today/tomorrow');
  } else if (days !== null && days <= 7) {
    target += 8;
    reasons.push('deadline is near');
  }

  if (snapshot.moment.mode === 'recovery' || snapshot.userState.energy === 'low') {
    target = goal.progress + Math.max(3, Math.round((target - goal.progress) * 0.45));
    reasons.push('reduced for low energy/recovery');
  } else if (snapshot.moment.mode === 'deadline_pressure') {
    target += 6;
    reasons.push('deadline-pressure mode');
  } else if (snapshot.userState.energy === 'high' && snapshot.userState.focusTrend === 'improving') {
    target += 4;
    reasons.push('stretch allowed by current energy');
  }

  return { target: clamp(Math.round(target), Math.min(100, goal.progress), 100), reasons };
}

function statusFor(goal: AdaptiveGoalInput, snapshot: PersonalizationSnapshot, target: number): AdaptiveGoalPolicy['adaptiveGoalStatus'] {
  if (!goal.active) return 'inactive';
  if (snapshot.moment.mode === 'protect_focus' && snapshot.today.doingTasks.some(title => textMatches(goal.title, title))) return 'protect';
  if (snapshot.moment.mode === 'recovery' || snapshot.userState.energy === 'low') return 'recovery_minimum';
  if (goal.health_status === 'off_track' || snapshot.moment.mode === 'deadline_pressure') return 'deadline_risk';
  if (goal.momentum !== null && goal.momentum < 0) return 'stalled';
  if (goal.progress >= target || goal.health_status === 'on_track') return 'aligned';
  return snapshot.userState.energy === 'high' ? 'stretch' : 'aligned';
}

function checkpointFor(goal: AdaptiveGoalInput, status: AdaptiveGoalPolicy['adaptiveGoalStatus']): string {
  const task = nextOpenTask(goal);
  const habit = weakestHabit(goal);

  if (status === 'inactive') return 'Inactive goal: reactivate only if it still matters.';
  if (status === 'recovery_minimum') {
    return task
      ? `Minimum checkpoint: touch "${task.title}" for one short session.`
      : habit
        ? `Minimum checkpoint: keep ${habit.icon} ${habit.name} alive once.`
        : 'Minimum checkpoint: write the next concrete step.';
  }
  if (status === 'deadline_risk') {
    return task ? `Risk checkpoint: move "${task.title}" before adding new work.` : 'Risk checkpoint: define the blocker and next task.';
  }
  if (status === 'protect') return 'Protect the current goal-aligned focus block.';
  if (status === 'stalled') return task ? `Restart checkpoint: finish or shrink "${task.title}".` : 'Restart checkpoint: attach one task or habit.';
  if (status === 'stretch') return task ? `Stretch checkpoint: advance "${task.title}" while energy is available.` : 'Stretch checkpoint: add a measurable next task.';
  return task ? `Next checkpoint: ${task.title}.` : habit ? `Support checkpoint: ${habit.icon} ${habit.name}.` : 'Next checkpoint: review the goal shape.';
}

export function buildAdaptiveGoalPolicy(
  goal: AdaptiveGoalInput,
  snapshot: PersonalizationSnapshot,
): AdaptiveGoalPolicy {
  const target = baseTarget(goal, snapshot);
  const status = statusFor(goal, snapshot, target.target);
  const delta = Math.max(0, target.target - goal.progress);
  const fit: AdaptiveGoalPolicy['adaptiveProgressFit'] =
    status === 'deadline_risk' || status === 'protect'
      ? 'high'
      : status === 'recovery_minimum' || status === 'stalled'
        ? 'medium'
        : 'low';

  return {
    adaptiveGoalStatus: status,
    adaptiveProgressTarget: target.target,
    adaptiveProgressDelta: delta,
    adaptiveProgressFit: fit,
    adaptiveGoalReason: target.reasons.join(' · '),
    adaptiveGoalCheckpoint: checkpointFor(goal, status),
  };
}
