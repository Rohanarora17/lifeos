import type { PersonalizationSnapshot } from './personalization-context';

export interface ActivityPolicyStats {
  productive_minutes: number;
  distraction_minutes: number;
  neutral_minutes: number;
  total_minutes: number;
  total_activities: number;
}

export interface AdaptiveActivityPolicy {
  mode: PersonalizationSnapshot['moment']['mode'];
  headline: string;
  subhead: string;
  emptyTitle: string;
  emptyMessage: string;
  primaryMetricLabel: string;
  productiveLabel: string;
  distractionLabel: string;
  neutralLabel: string;
  posture: 'protect_focus' | 'deadline_relief' | 'recovery_capacity' | 'planning_signal' | 'baseline';
  interpretation: string;
  plannedFocus: PersonalizationSnapshot['today']['plannedFocus'];
  nextBestFocusWindow: string;
}

function minutes(value: number): string {
  if (value < 60) return `${Math.round(value)}m`;
  const hours = Math.floor(value / 60);
  const mins = Math.round(value % 60);
  return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
}

export function buildAdaptiveActivityPolicy(
  snapshot: PersonalizationSnapshot,
  stats: ActivityPolicyStats | null,
): AdaptiveActivityPolicy {
  const productive = Math.round(stats?.productive_minutes ?? 0);
  const distraction = Math.round(stats?.distraction_minutes ?? 0);
  const total = Math.round(stats?.total_minutes ?? 0);
  const planned = snapshot.today.plannedFocus;
  const hasSignal = total > 0;

  if (snapshot.moment.mode === 'protect_focus' || planned.nextTitle) {
    const title = planned.nextTitle ?? snapshot.activeSession?.targetTitle ?? 'the protected block';
    return {
      mode: snapshot.moment.mode,
      headline: `Activity around ${title}`,
      subhead: hasSignal
        ? `${minutes(productive)} productive and ${minutes(distraction)} distraction tracked against the current plan.`
        : `No activity signal yet for ${title}; start the block so LifeOS can compare planned vs actual work.`,
      emptyTitle: 'No activity for the planned block',
      emptyMessage: `Start ${title}${planned.nextMinutes ? ` for ${planned.nextMinutes}m` : ''} so this timeline can learn what helps or derails it.`,
      primaryMetricLabel: 'Plan fit',
      productiveLabel: 'Useful for plan',
      distractionLabel: 'Plan drift',
      neutralLabel: 'Context',
      posture: 'protect_focus',
      interpretation: 'Activity is judged by whether it protects the scheduled focus block, not by generic browsing labels.',
      plannedFocus: planned,
      nextBestFocusWindow: snapshot.userState.nextBestFocusWindow,
    };
  }

  if (snapshot.moment.mode === 'deadline_pressure') {
    return {
      mode: snapshot.moment.mode,
      headline: 'Activity for deadline relief',
      subhead: hasSignal
        ? `${minutes(productive)} productive time should map to the closest deadline; ${minutes(distraction)} distraction needs a trigger review.`
        : 'No activity signal yet. Track the first pressure-relief block before optional browsing.',
      emptyTitle: 'No deadline-relief signal',
      emptyMessage: 'Start the highest-pressure task so activity classification can learn what actually moved the deadline forward.',
      primaryMetricLabel: 'Relief signal',
      productiveLabel: 'Deadline work',
      distractionLabel: 'Pressure leak',
      neutralLabel: 'Support context',
      posture: 'deadline_relief',
      interpretation: 'During deadline pressure, useful activity is whatever reduces the nearest real obligation.',
      plannedFocus: planned,
      nextBestFocusWindow: snapshot.userState.nextBestFocusWindow,
    };
  }

  if (snapshot.moment.mode === 'recovery' || snapshot.userState.energy === 'low' || snapshot.userState.mood === 'low') {
    return {
      mode: snapshot.moment.mode,
      headline: 'Activity against recovery capacity',
      subhead: hasSignal
        ? `${minutes(total)} tracked today; the goal is a sustainable signal, not maximum volume.`
        : 'No activity signal yet. One small useful block is enough to calibrate a low-energy day.',
      emptyTitle: 'No recovery signal yet',
      emptyMessage: 'Capture one low-friction block or rest context so LifeOS can separate recovery from avoidance.',
      primaryMetricLabel: 'Capacity fit',
      productiveLabel: 'Sustainable work',
      distractionLabel: 'Avoidance risk',
      neutralLabel: 'Recovery context',
      posture: 'recovery_capacity',
      interpretation: 'Low-capacity days should teach the model what remains workable instead of being scored like normal days.',
      plannedFocus: planned,
      nextBestFocusWindow: snapshot.userState.nextBestFocusWindow,
    };
  }

  if (snapshot.moment.mode === 'planning') {
    return {
      mode: snapshot.moment.mode,
      headline: 'Activity for tomorrow planning',
      subhead: hasSignal
        ? `${minutes(productive)} productive and ${minutes(distraction)} distraction become inputs for tomorrow's schedule.`
        : 'No activity signal yet. Planning is stronger when it has calendar, browsing, and focus evidence.',
      emptyTitle: 'No planning evidence',
      emptyMessage: 'Use this window for calendar review, notes, or one setup block so tomorrow planning has signal.',
      primaryMetricLabel: 'Tomorrow input',
      productiveLabel: 'Setup work',
      distractionLabel: 'Avoid tomorrow',
      neutralLabel: 'Planning context',
      posture: 'planning_signal',
      interpretation: 'Evening activity should tell the planner what tomorrow should inherit, avoid, or schedule differently.',
      plannedFocus: planned,
      nextBestFocusWindow: snapshot.userState.nextBestFocusWindow,
    };
  }

  return {
    mode: snapshot.moment.mode,
    headline: 'Activity against your baseline',
    subhead: hasSignal
      ? `${minutes(productive)} productive and ${minutes(distraction)} distraction tracked against your learned focus window.`
      : `No activity signal yet. Seed the baseline near ${snapshot.userState.nextBestFocusWindow || 'your next useful focus window'}.`,
    emptyTitle: 'No activity for this date',
    emptyMessage: snapshot.userState.nextBestFocusWindow
      ? `Track one focused block near ${snapshot.userState.nextBestFocusWindow} so LifeOS can compare plan, context, and outcome.`
      : 'Browse with tracking enabled or start a Guardian session so LifeOS can learn the day pattern.',
    primaryMetricLabel: 'Baseline fit',
    productiveLabel: 'Productive',
    distractionLabel: 'Distraction',
    neutralLabel: 'Neutral',
    posture: 'baseline',
    interpretation: 'Activity is compared against personal baselines instead of a generic productivity ideal.',
    plannedFocus: planned,
    nextBestFocusWindow: snapshot.userState.nextBestFocusWindow,
  };
}
