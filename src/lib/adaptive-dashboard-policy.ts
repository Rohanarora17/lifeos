import type { AdaptiveRecommendedTask } from './adaptive-task-recommendations';
import type { PersonalizationSnapshot } from './personalization-context';

export type DashboardPrimaryAction =
  | 'continue_focus'
  | 'start_recommended_task'
  | 'clear_deadline'
  | 'minimum_habit'
  | 'plan_tomorrow'
  | 'recover'
  | 'review_day';

export interface AdaptiveDashboardPolicy {
  mode: PersonalizationSnapshot['moment']['mode'];
  headline: string;
  primaryAction: DashboardPrimaryAction;
  primaryLabel: string;
  primaryReason: string;
  focusTarget: {
    type: 'task' | 'session' | 'habit' | 'planning' | 'review';
    id: number | null;
    title: string;
  };
  sessionMinutes: number;
  sessionReason: string;
  notificationPosture: 'normal' | 'quiet' | 'urgent_only';
  notificationReason: string;
  dashboardEmphasis: Array<'tasks' | 'habits' | 'calendar' | 'recovery' | 'reflection' | 'activity'>;
}

interface DashboardPolicyInput {
  snapshot: PersonalizationSnapshot;
  recommendedTasks: AdaptiveRecommendedTask[];
  recommendedSessionMinutes: number;
  habitStats: { completed_today?: number; total_habits?: number };
  unreadAlerts: number;
  productiveMinutes: number;
  distractionMinutes: number;
}

function plural(count: number, singular: string, pluralLabel = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralLabel}`;
}

function topTask(input: DashboardPolicyInput): AdaptiveRecommendedTask | null {
  return input.recommendedTasks[0] ?? null;
}

function sessionMinutesFor(input: DashboardPolicyInput, task: AdaptiveRecommendedTask | null): { minutes: number; reason: string } {
  const learned = Math.max(10, Math.round(input.recommendedSessionMinutes));
  if (!task?.estimatedMinutes) {
    if (input.snapshot.moment.mode === 'recovery') {
      return { minutes: Math.min(learned, 25), reason: 'shortened because today is recovery-biased' };
    }
    return { minutes: learned, reason: 'learned from recent focus session length' };
  }

  if (input.snapshot.moment.mode === 'recovery') {
    return {
      minutes: Math.max(10, Math.min(learned, Math.ceil(task.estimatedMinutes / 3))),
      reason: 'uses the smallest useful slice of the task for low-energy mode',
    };
  }

  if (input.snapshot.moment.mode === 'deadline_pressure') {
    return {
      minutes: Math.max(learned, Math.min(task.estimatedMinutes, learned + 15)),
      reason: 'stretched slightly because the current mode needs deadline relief',
    };
  }

  return {
    minutes: Math.min(task.estimatedMinutes, learned),
    reason: task.estimatedMinutes <= learned ? 'task fits inside your learned sprint' : 'starts with your learned sprint before the task gets too large',
  };
}

function notificationPosture(input: DashboardPolicyInput): Pick<AdaptiveDashboardPolicy, 'notificationPosture' | 'notificationReason'> {
  if (input.snapshot.feedback.alertFatigueLevel === 'high') {
    return {
      notificationPosture: 'urgent_only',
      notificationReason: 'recent alert volume is high, so the dashboard should not pile on',
    };
  }
  if (input.snapshot.moment.mode === 'protect_focus') {
    return {
      notificationPosture: 'quiet',
      notificationReason: 'active focus is worth protecting',
    };
  }
  if (input.unreadAlerts > 0 && input.snapshot.moment.mode === 'deadline_pressure') {
    return {
      notificationPosture: 'normal',
      notificationReason: 'alerts remain visible because there is deadline pressure',
    };
  }
  return {
    notificationPosture: 'normal',
    notificationReason: 'alert volume and current mode allow normal notification visibility',
  };
}

export function buildAdaptiveDashboardPolicy(input: DashboardPolicyInput): AdaptiveDashboardPolicy {
  const snapshot = input.snapshot;
  const task = topTask(input);
  const session = sessionMinutesFor(input, task);
  const notifications = notificationPosture(input);
  const habitsLeft = Math.max(0, (input.habitStats.total_habits ?? 0) - (input.habitStats.completed_today ?? 0));
  const emphasis = new Set<AdaptiveDashboardPolicy['dashboardEmphasis'][number]>();

  if (snapshot.today.calendarEvents.length > 0) emphasis.add('calendar');
  if (input.distractionMinutes > input.productiveMinutes && input.distractionMinutes >= 20) emphasis.add('activity');

  if (snapshot.activeSession) {
    emphasis.add('tasks');
    return {
      mode: snapshot.moment.mode,
      headline: `Stay with ${snapshot.activeSession.targetTitle}`,
      primaryAction: 'continue_focus',
      primaryLabel: 'Continue current session',
      primaryReason: `Current focus score is ${snapshot.activeSession.focusScore ?? 'still learning'} after ${snapshot.activeSession.elapsedMinutes}m.`,
      focusTarget: {
        type: 'session',
        id: null,
        title: snapshot.activeSession.targetTitle,
      },
      sessionMinutes: Math.max(5, session.minutes),
      sessionReason: 'active session already defines the work block',
      ...notifications,
      dashboardEmphasis: Array.from(emphasis),
    };
  }

  if (snapshot.moment.mode === 'deadline_pressure' && task) {
    emphasis.add('tasks');
    return {
      mode: snapshot.moment.mode,
      headline: `Clear pressure with ${task.title}`,
      primaryAction: 'clear_deadline',
      primaryLabel: `Start ${session.minutes}m on this`,
      primaryReason: `${task.reason}. This is the strongest deadline-relief candidate right now.`,
      focusTarget: { type: 'task', id: task.id, title: task.title },
      sessionMinutes: session.minutes,
      sessionReason: session.reason,
      ...notifications,
      dashboardEmphasis: Array.from(emphasis),
    };
  }

  if (snapshot.moment.mode === 'recovery') {
    emphasis.add('recovery');
    if (task) emphasis.add('tasks');
    if (habitsLeft > 0) emphasis.add('habits');
    return {
      mode: snapshot.moment.mode,
      headline: task ? `Make ${task.title} smaller` : 'Keep today recoverable',
      primaryAction: task ? 'start_recommended_task' : 'recover',
      primaryLabel: task ? `Do ${session.minutes}m only` : 'Pick one low-friction action',
      primaryReason: task
        ? `${task.reason}. Recovery mode should reduce the ask instead of dropping the day.`
        : 'Energy or mood is low, so the dashboard should bias toward minimum viable progress.',
      focusTarget: task
        ? { type: 'task', id: task.id, title: task.title }
        : { type: 'review', id: null, title: 'Recovery check-in' },
      sessionMinutes: session.minutes,
      sessionReason: session.reason,
      ...notifications,
      dashboardEmphasis: Array.from(emphasis),
    };
  }

  if (snapshot.moment.mode === 'planning' || snapshot.today.dayPhase === 'evening' || snapshot.today.dayPhase === 'night') {
    emphasis.add('reflection');
    if (snapshot.today.calendarEvents.length > 0) emphasis.add('calendar');
    return {
      mode: snapshot.moment.mode,
      headline: 'Set up tomorrow from today’s real signals',
      primaryAction: 'plan_tomorrow',
      primaryLabel: 'Open next-day planner',
      primaryReason: snapshot.today.openTasks > 0
        ? `${plural(snapshot.today.openTasks, 'open task')} should be translated into tomorrow’s schedule.`
        : 'This is a better moment for reflection and planning than starting new work.',
      focusTarget: { type: 'planning', id: null, title: 'Next-day plan' },
      sessionMinutes: session.minutes,
      sessionReason: session.reason,
      ...notifications,
      dashboardEmphasis: Array.from(emphasis),
    };
  }

  if (task) {
    emphasis.add('tasks');
    return {
      mode: snapshot.moment.mode,
      headline: `Best next block: ${task.title}`,
      primaryAction: 'start_recommended_task',
      primaryLabel: `Start ${session.minutes}m focus`,
      primaryReason: task.reason || snapshot.moment.guidance,
      focusTarget: { type: 'task', id: task.id, title: task.title },
      sessionMinutes: session.minutes,
      sessionReason: session.reason,
      ...notifications,
      dashboardEmphasis: Array.from(emphasis),
    };
  }

  if (habitsLeft > 0) {
    emphasis.add('habits');
    return {
      mode: snapshot.moment.mode,
      headline: `Close ${plural(habitsLeft, 'habit')} before adding more`,
      primaryAction: 'minimum_habit',
      primaryLabel: 'Do one habit',
      primaryReason: 'No task is a strong fit, so habit consistency is the best next signal.',
      focusTarget: { type: 'habit', id: null, title: snapshot.today.uncheckedHabits[0] ?? 'Habit check-in' },
      sessionMinutes: session.minutes,
      sessionReason: session.reason,
      ...notifications,
      dashboardEmphasis: Array.from(emphasis),
    };
  }

  emphasis.add('reflection');
  return {
    mode: snapshot.moment.mode,
    headline: 'Review the day and update the model',
    primaryAction: 'review_day',
    primaryLabel: 'Reflect now',
    primaryReason: 'No urgent task or habit is open, so the highest-value action is giving the system fresh feedback.',
    focusTarget: { type: 'review', id: null, title: 'Evening reflection' },
    sessionMinutes: session.minutes,
    sessionReason: session.reason,
    ...notifications,
    dashboardEmphasis: Array.from(emphasis),
  };
}
